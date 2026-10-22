"""Separate Banban's original painted feet for the native island's running rig."""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw


root = Path(__file__).resolve().parents[1]
source = root / 'web_controller/assets/banban/body.webp'
destination = root / 'Receiver/Assets/Banban'
destination.mkdir(parents=True, exist_ok=True)
body = Image.open(source).convert('RGBA')
assert body.size == (640, 819), 'Review the leg masks when the source artwork changes.'
combined = Image.new('L', body.size)
for name, polygon in {
    'leg-left': [(145, 698), (286, 708), (286, 818), (136, 818)],
    'leg-right': [(308, 710), (460, 720), (470, 819), (308, 819)],
}.items():
    mask = Image.new('L', body.size)
    ImageDraw.Draw(mask).polygon(polygon, fill=255)
    leg = body.copy()
    leg.putalpha(ImageChops.multiply(body.getchannel('A'), mask))
    leg.save(destination / f'{name}.webp', lossless=True, method=6)
    combined = ImageChops.lighter(combined, mask)
body.putalpha(ImageChops.multiply(body.getchannel('A'), ImageChops.invert(combined)))
body.save(destination / 'body-running.webp', lossless=True, method=6)
print('Prepared three lossless layers from the existing Banban artwork.')
