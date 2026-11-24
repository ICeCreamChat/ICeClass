"""Short-lived preview connections issued by the existing VideoBooth service."""
import asyncio
import logging
import secrets
from urllib.parse import urlsplit

from aiohttp import ClientError, ClientSession, ClientTimeout


class PreviewTurn:
    def __init__(self, endpoint):
        endpoint = endpoint.rstrip('/')
        uri = urlsplit(endpoint)
        self.endpoint = endpoint if uri.scheme == 'https' and uri.hostname and not (
            uri.username or uri.password or uri.query or uri.fragment) else ''
        self.tasks = {}
        self.expiry = {}

    def servers(self, pair_id, role, *, prepare=False):
        """None means preparing. Polling and durable answer receipts never wait for TURN."""
        task = self.tasks.get(pair_id)
        if task is None:
            if not prepare or not self.endpoint:
                return []
            task = self.tasks[pair_id] = asyncio.create_task(self.issue())
            task.add_done_callback(lambda done: self.schedule_expiry(pair_id, done))
        if not task.done():
            return None
        return task.result().get(role, [])

    def schedule_expiry(self, pair_id, task):
        if task.cancelled() or self.tasks.get(pair_id) is not task:
            return
        # VideoBooth issues two-hour credentials. Renew well before that on the next connection.
        lifetime = 3600 if task.result() else 30
        def expire():
            self.tasks.pop(pair_id, None)
            self.expiry.pop(pair_id, None)
        self.expiry[pair_id] = asyncio.get_running_loop().call_later(lifetime, expire)

    async def close(self, app):
        tasks = list(self.tasks.values())
        self.tasks.clear()
        for handle in self.expiry.values():
            handle.cancel()
        self.expiry.clear()
        if tasks:
            # Let the short requests finish so temporary registration is released.
            await asyncio.gather(*tasks, return_exceptions=True)

    async def issue(self):
        # The temporary room has no classroom identifiers and never carries signalling or media.
        room = {'id': secrets.token_urlsafe(18), 'viewerKey': secrets.token_urlsafe(32),
                'joinKey': secrets.token_urlsafe(32)}
        async with ClientSession(timeout=ClientTimeout(total=3), raise_for_status=True) as client:
            try:
                async with client.post(self.endpoint + '/api/rooms', json=room, allow_redirects=False) as response:
                    board = (await response.json())['iceServers']
                async with client.get(self.endpoint + '/api/phone', params={'room': room['id'], 'join': room['joinKey']},
                                      allow_redirects=False) as response:
                    phone = (await response.json())['iceServers']
                if all(isinstance(items, list) and items for items in (board, phone)):
                    return {'board': board, 'phone': phone}
            except (ClientError, asyncio.TimeoutError, ValueError, KeyError, TypeError):
                logging.getLogger(__name__).warning('VideoBooth preview relay is temporarily unavailable.')
            finally:
                # TURN credentials are independently time-limited and survive room removal.
                try:
                    async with client.delete(self.endpoint + '/api/rooms/' + room['id'],
                                             headers={'Authorization': 'Bearer ' + room['viewerKey']},
                                             allow_redirects=False):
                        pass
                except (ClientError, asyncio.TimeoutError):
                    pass  # The booth also expires idle registrations.
        return {}
