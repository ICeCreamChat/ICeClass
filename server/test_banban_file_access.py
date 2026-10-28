from test_app import ServerTestCase
import test_banban_operations as fixtures


class FileAccessTest(ServerTestCase):
    setup_device = fixtures.OperationTest.setup_device
    socket = fixtures.OperationTest.socket
    ack = fixtures.OperationTest.ack
    create = fixtures.OperationTest.create
    computer = fixtures.OperationTest.computer

    async def test_browse_preserves_folder_scope_and_pagination(self):
        await self.setup_device()
        ws = await self.socket()
        try:
            response, operation = await self.computer('list_files', folderPath='D:\\教学资料',
                                                      query='*', recursive=False, offset=80)
            self.assertEqual(response.status, 200, operation)
            command = await ws.receive_json()
            self.assertEqual(command['parameters']['folderPath'], 'D:\\教学资料')
            self.assertEqual(command['parameters']['offset'], 80)
            self.assertIs(command['parameters']['recursive'], False)
            await self.ack(ws, command, files=[], directories=[], nextOffset=None)
        finally:
            await ws.close()

    async def test_browse_options_cannot_modify_a_file_action(self):
        await self.setup_device()
        ws = await self.socket()
        try:
            for extra in [{'folderPath': 'C:\\'}, {'recursive': True}, {'offset': 0}]:
                response, _ = await self.computer('recycle_file', fileId='unknown', **extra)
                self.assertEqual(response.status, 400)
            for extra in [{'folderPath': 3}, {'folderPath': 'bad\0path'},
                          {'recursive': 'true'}, {'offset': -1}, {'offset': True}]:
                response, _ = await self.computer('list_files', **extra)
                self.assertEqual(response.status, 400)
        finally:
            await ws.close()
