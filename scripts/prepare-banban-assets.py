"""Extract the user supplied Banban artwork; requires Pillow for asset preparation only."""
import argparse
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw


def cutout(image):
    image = image.convert('RGBA')
    w, h = image.size
    pixels = image.load()
    queue = deque()
    seen = bytearray(w * h)
    for x in range(w):
        queue.extend(((x, 0), (x, h - 1)))
    for y in range(h):
        queue.extend(((0, y), (w - 1, y)))
    while queue:
        x, y = queue.popleft()
        if x < 0 or y < 0 or x >= w or y >= h or seen[y * w + x]:
            continue
        seen[y * w + x] = 1
        r, g, b, a = pixels[x, y]
        if min(r, g, b) < 240 or max(r, g, b) - min(r, g, b) > 14:
            continue
        pixels[x, y] = (r, g, b, 0)
        queue.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    return image


def prepare_expressions(root, out, assets):
    """Place real painted parts on a shared canvas so faces never jump between states."""
    sheets = {name: Image.open(root / f'branding/banban/{name}.jpg') for name in ('smile', 'emotions', 'thinking')}
    boxes = {
        'closed-left': ('smile', (145, 515, 645, 705)),
        'closed-right': ('smile', (955, 515, 1455, 705)),
        'smile-mouth': ('smile', (575, 1005, 1025, 1160)),
        'waiting-left': ('emotions', (400, 235, 705, 435)),
        'waiting-right': ('emotions', (875, 235, 1175, 435)),
        'waiting-mouth': ('emotions', (680, 495, 905, 550)),
        'happy-left': ('emotions', (425, 730, 695, 965)),
        'happy-right': ('emotions', (885, 730, 1155, 965)),
        'happy-mouth': ('emotions', (720, 1010, 855, 1130)),
        'arm-think': ('emotions', (880, 990, 1365, 1440)),
        'thinking-left': ('thinking', (120, 255, 445, 525)),
        'thinking-right': ('thinking', (610, 265, 905, 525)),
        'thinking-mouth': ('thinking', (420, 675, 630, 740)),
    }
    pieces = {}
    for name, (sheet_name, box) in boxes.items():
        sheet = sheets[sheet_name]
        scale = sheet.width / (1024 if sheet_name == 'thinking' else 1600)
        part = cutout(sheet.crop(tuple(round(v * scale) for v in box)))
        pieces[name] = part.crop(part.getbbox())
    positions = ((187, 217, 106, 91), (378, 225, 106, 91))

    def layer(parts):
        canvas = Image.new('RGBA', (660, 720))
        for part, (x, y, w, h) in parts:
            image = part.copy()
            image.thumbnail((w, h), Image.Resampling.LANCZOS)
            canvas.alpha_composite(image, (round(x + (w - image.width) / 2), round(y + (h - image.height) / 2)))
        return canvas

    faces = {}
    for mood in ('neutral', 'smile', 'waiting', 'thinking', 'happy'):
        source = assets if mood == 'neutral' else pieces
        prefix = 'eye' if mood == 'neutral' else 'closed' if mood == 'smile' else mood
        eye_parts = [(source[f'{prefix}-{side}'], position) for side, position in zip(('left', 'right'), positions)]
        eyes = layer(eye_parts)
        mouth = assets['mouth'] if mood == 'neutral' else pieces[f'{mood}-mouth']
        mouth_position = (291, 311, 82, 42) if mood == 'happy' else (291, 320, 82, 24)
        lips = layer([(mouth, mouth_position)])
        eyes.save(out / f'eyes-{mood}.webp', quality=94, method=6)
        lips.save(out / f'mouth-{mood}.webp', quality=94, method=6)
        faces[mood] = (eyes, lips)
    # This raised arm connects behind the book; the book cover hides its cut edge.
    arm = layer([(pieces['arm-think'], (475, 265, 180, 185))])
    arm.save(out / 'arm-think.webp', quality=94, method=6)
    review = Image.new('RGB', (1350, 390), '#e8f2ff')
    draw = ImageDraw.Draw(review)
    base_layout = {'arm-left': (0, 327, 150, 140), 'arm-right': (540, 410, 114, 170), 'body': (100, 60, 500, 629), 'bookmark': (423, 54, 108, 110), 'mas': (246, 386, 146, 146)}
    for i, (mood, face) in enumerate(faces.items()):
        portrait = Image.new('RGBA', (660, 720))
        for name, (x, y, w, h) in base_layout.items():
            if name == 'arm-right' and mood in ('thinking', 'waiting'):
                portrait.alpha_composite(arm)
                continue
            portrait.alpha_composite(assets[name].resize((w, h), Image.Resampling.LANCZOS), (x, y))
        for image in face:
            portrait.alpha_composite(image)
        portrait.thumbnail((245, 295), Image.Resampling.LANCZOS)
        review.paste(portrait, (i * 270 + 10, 40), portrait)
        draw.text((i * 270 + 15, 330), mood, fill='#163c65')
    review.save(root / 'output/banban/expression-review.png')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('sheet', type=Path)
    parser.add_argument('logo', type=Path)
    parser.add_argument('--expressions', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    out = root / 'web_controller/assets/banban'
    out.mkdir(parents=True, exist_ok=True)
    sheet = Image.open(args.sheet)
    scale = sheet.width / 1600
    boxes = {
        'body': (958, 149, 1473, 797),
        'eye-left': (1027, 825, 1171, 948),
        'eye-right': (1235, 826, 1379, 948),
        'mouth': (1142, 1009, 1255, 1042),
        'arm-left': (989, 1098, 1151, 1248),
        'arm-right': (1282, 1101, 1407, 1284),
        'bookmark': (1149, 1309, 1292, 1454),
    }
    assets = {}
    for name, box in boxes.items():
        part = cutout(sheet.crop(tuple(round(v * scale) for v in box)))
        part = part.crop(part.getbbox())
        part.save(out / (name + '.webp'), quality=92, method=6)
        assets[name] = part
    logo = cutout(Image.open(args.logo))
    # The light mark outside the emblem is part of the reference background.
    # Keep the connected emblem, preserving its white lettering and silver rim.
    visible = logo.getchannel('A')
    keep = Image.new('L', logo.size)
    pending = deque([(logo.width // 2, logo.height // 2)])
    mask, alpha = keep.load(), visible.load()
    while pending:
        x, y = pending.popleft()
        if x < 0 or y < 0 or x >= logo.width or y >= logo.height or mask[x, y] or not alpha[x, y]:
            continue
        mask[x, y] = 255
        pending.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))
    logo.putalpha(keep)
    logo.save(out / 'mas.webp', quality=94, method=6)
    assets['mas'] = logo
    layout = {
        'arm-left': (0, 327, 150, 140), 'arm-right': (540, 410, 114, 170),
        'body': (100, 60, 500, 629), 'eye-left': (187, 217, 106, 91),
        'eye-right': (378, 225, 106, 91), 'mouth': (291, 320, 82, 24),
        'bookmark': (423, 54, 108, 110), 'mas': (246, 386, 146, 146),
    }
    portrait = Image.new('RGBA', (660, 720))
    for name, (x, y, w, h) in layout.items():
        portrait.alpha_composite(assets[name].resize((w, h), Image.Resampling.LANCZOS), (x, y))
    portrait.save(out / 'portrait.webp', quality=94, method=6)
    review = Image.new('RGB', (1100, 810), '#e8f2ff')
    review.paste(portrait, (0, 55), portrait)
    draw = ImageDraw.Draw(review)
    for i, (name, part) in enumerate(assets.items()):
        thumb = part.copy()
        thumb.thumbnail((170, 150))
        x, y = 700 + (i % 2) * 190, 20 + (i // 2) * 192
        review.paste(thumb, (x, y + 25), thumb)
        draw.text((x, y), name, fill='#163c65')
    review_path = root / 'output/banban/asset-review.png'
    review_path.parent.mkdir(parents=True, exist_ok=True)
    review.save(review_path)
    if args.expressions:
        prepare_expressions(root, out, assets)
    print('Prepared', len(assets), 'parts and portrait:', out)


if __name__ == '__main__':
    main()
