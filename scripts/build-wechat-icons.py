"""Build the mini-program's small geometric navigation icons and reuse its teacher logo."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
TARGET = ROOT / 'miniprogram' / 'teacher' / 'assets'
INK = '#2869a6'
SCALE = 8


def build(name, painter):
    image = Image.new('RGBA', (24 * SCALE, 24 * SCALE))
    canvas = ImageDraw.Draw(image)
    def line(points):
        canvas.line([(int(x * SCALE), int(y * SCALE)) for x, y in points], fill=INK, width=2 * SCALE, joint='curve')
    def rect(box, radius=2):
        canvas.rounded_rectangle(tuple(int(v * SCALE) for v in box), radius=radius * SCALE, outline=INK, width=2 * SCALE)
    def oval(box):
        canvas.ellipse(tuple(int(v * SCALE) for v in box), outline=INK, width=2 * SCALE)
    painter(line, rect, oval)
    image.resize((72, 72), Image.Resampling.LANCZOS).save(TARGET / 'icons' / (name + '.png'), optimize=True)


def main():
    (TARGET / 'icons').mkdir(parents=True, exist_ok=True)
    with Image.open(ROOT / 'branding' / 'teacher' / 'app-icon.png') as image:
        image.convert('RGBA').resize((144, 144), Image.Resampling.LANCZOS).save(TARGET / 'app-icon.png', optimize=True)
    icons = {
        'notice': lambda l, r, o: (l([(4, 10), (15, 5), (15, 19), (4, 15), (4, 10)]), l([(7, 16), (8, 21), (11, 21), (10, 17)]), l([(19, 9), (22, 7)]), l([(19, 15), (22, 17)])),
        'paper': lambda l, r, o: (r((4, 3, 20, 21)), r((7, 6, 11, 10), 0), l([(15, 7), (17, 7)]), l([(8, 15), (17, 15)]), l([(8, 18), (14, 18)])),
        'homework': lambda l, r, o: (r((5, 4, 19, 21)), r((9, 2, 15, 6), 1), l([(8, 12), (10, 14), (16, 9)]), l([(8, 18), (16, 18)])),
        'reading': lambda l, r, o: (l([(12, 5), (8, 3), (3, 3), (3, 18), (8, 18), (12, 21), (16, 18), (21, 18), (21, 3), (16, 3), (12, 5), (12, 21)])),
        'calendar': lambda l, r, o: (r((3, 5, 21, 21)), l([(3, 10), (21, 10)]), l([(8, 2), (8, 7)]), l([(16, 2), (16, 7)]), l([(7, 15), (10, 15)]), l([(14, 15), (17, 15)])),
        'history': lambda l, r, o: (r((5, 3, 19, 21)), l([(8, 8), (16, 8)]), l([(8, 12), (16, 12)]), l([(8, 16), (13, 16)])),
        'quiet': lambda l, r, o: (o((3, 3, 21, 21)), l([(12, 6), (12, 12), (16, 15)])),
        'questions': lambda l, r, o: (r((4, 3, 20, 21)), l([(9, 8), (10, 6), (14, 6), (16, 8), (16, 10), (12, 13), (12, 15)]), o((11, 17, 13, 19))),
        'voice': lambda l, r, o: (r((9, 3, 15, 15), 3), l([(5, 11), (5, 14), (8, 18), (16, 18), (19, 14), (19, 11)]), l([(12, 18), (12, 22)])),
        'controls': lambda l, r, o: (l([(4, 5), (20, 5)]), l([(4, 12), (20, 12)]), l([(4, 19), (20, 19)]), o((7, 2, 13, 8)), o((13, 9, 19, 15)), o((5, 16, 11, 22))),
        'classes': lambda l, r, o: (r((3, 3, 10, 10), 1), r((14, 3, 21, 10), 1), r((3, 14, 10, 21), 1), r((14, 14, 21, 21), 1)),
        'users': lambda l, r, o: (o((8, 3, 16, 11)), l([(4, 21), (4, 17), (7, 14), (17, 14), (20, 17), (20, 21)])),
        'ideas': lambda l, r, o: (l([(9, 17), (9, 15), (6, 12), (6, 7), (9, 4), (15, 4), (18, 7), (18, 12), (15, 15), (15, 17), (9, 17)]), l([(9, 20), (15, 20)])),
    }
    for name, painter in icons.items():
        build(name, painter)
    print(f'Built teacher logo and {len(icons)} navigation icons.')


if __name__ == '__main__':
    main()
