"""Extract the user's painted holding-arm sheet without removing cream interiors."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def remove_connected_white(picture, seed):
    rgb = np.asarray(picture.convert('RGB')).astype(np.float32)
    darkness = 255 - rgb.min(axis=2)
    outline = Image.fromarray(np.uint8(darkness >= 32) * 255, 'L').copy()
    # Only the background connected to the border is removed. The closed brown
    # outlines preserve light cream interiors even when they are almost white.
    ImageDraw.floodfill(outline, (0, 0), 128)
    inside = Image.fromarray(np.uint8(np.asarray(outline) != 128) * 255, 'L')
    component = inside.copy()
    ImageDraw.floodfill(component, seed, 128)
    inside = Image.fromarray(np.uint8(np.asarray(component) == 128) * 255, 'L')
    near = np.asarray(inside.filter(ImageFilter.MaxFilter(3))) > 0
    core = np.asarray(inside.filter(ImageFilter.MinFilter(3))) > 0
    edge_rgb = np.asarray(picture.convert('RGB').filter(ImageFilter.MinFilter(3))).astype(np.float32)
    edge_darkness = np.maximum(1, 255 - edge_rgb.min(axis=2))
    alpha = np.where(core, 1, np.clip(darkness / edge_darkness, 0, 1))
    alpha = np.where(near & (alpha >= .03), alpha, 0)
    color = np.clip((rgb - 255 * (1 - alpha[..., None])) / np.maximum(alpha[..., None], .001), 0, 255)
    result = Image.fromarray(np.dstack((color, alpha * 255)).round().astype(np.uint8), 'RGBA')
    return result.crop(result.getbbox())


def left_holding_module(sprite):
    pixels = np.array(sprite)
    yy, xx = np.indices(pixels.shape[:2])
    blue = (pixels[:, :, 2].astype(int) > pixels[:, :, 0].astype(int) + 5) & (pixels[:, :, 3] > 0)
    # The reference's bell faces right. Reflect the blue prop around its rear
    # handle, retaining the painted fingers, thumb and occluded grip pixels.
    # Keeping that grip overlay also fills the finger-shaped holes in the
    # reflected prop; the resulting module is one rigid animation sprite.
    retained_handle = (xx >= 235) & (xx <= 315) & (yy >= 255)
    prop = sprite.copy()
    prop.putalpha(Image.fromarray(np.where(blue, pixels[:, :, 3], 0).astype('uint8')))
    grip = sprite.copy()
    grip.putalpha(Image.fromarray(np.where(~blue | retained_handle, pixels[:, :, 3], 0).astype('uint8')))
    result = Image.new('RGBA', (740, 500))
    result.alpha_composite(prop.transpose(Image.Transpose.FLIP_LEFT_RIGHT), (80 + 552 - sprite.width, 20))
    result.alpha_composite(grip, (80, 20))
    # Fade only the closed proximal wrist cap into the overlapping painted arm.
    # The fingers, thumb, handle and bell remain fully opaque and unmodified.
    pixels = np.array(result)
    _, xx = np.indices(pixels.shape[:2])
    warm = pixels[:, :, 0].astype(int) >= pixels[:, :, 2].astype(int)
    phase = np.clip((xx - 110) / 80, 0, 1)
    blend = phase * phase * (3 - 2 * phase)
    pixels[:, :, 3] = np.round(pixels[:, :, 3] * np.where(warm, blend, 1)).astype('uint8')
    return Image.fromarray(pixels, 'RGBA')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--assets', type=Path, help='Optional production resource directory (only the two animated sprites).')
    args = parser.parse_args()
    source = Image.open(args.source).convert('RGB')
    if source.size != (2400, 1792):
        raise ValueError('This extraction is registered to the supplied 2400 x 1792 sheet.')
    args.output.mkdir(parents=True, exist_ok=True)
    regions = {
        'holding-upper': (475, 160, 710, 580),
        'holding-bent': (385, 665, 840, 1070),
        'holding-hand-horn': (280, 1140, 980, 1630),
        'holding-carry-reference': (1440, 70, 2010, 700),
        'holding-raised-reference': (1390, 690, 2110, 1180),
        'holding-lift-reference': (1390, 1150, 2170, 1710),
    }
    seeds = {
        'holding-upper': (580, 340), 'holding-bent': (600, 940),
        'holding-hand-horn': (700, 1370), 'holding-carry-reference': (1590, 470),
        'holding-raised-reference': (1730, 900), 'holding-lift-reference': (1770, 1400),
    }
    sizes = {}
    sprites = {}
    for name, box in regions.items():
        seed = (seeds[name][0] - box[0], seeds[name][1] - box[1])
        sprite = remove_connected_white(source.crop(box), seed)
        sprites[name] = sprite
        sprite.save(args.output / f'{name}.webp', lossless=True, method=6)
        sprite.save(args.output / f'{name}.png')
        sizes[name] = sprite.size
        print(name, sprite.size)
    module = left_holding_module(sprites['holding-hand-horn'])
    module.save(args.output / 'holding-hand-horn-left.png')
    module.save(args.output / 'holding-hand-horn-left.webp', lossless=True, method=6)
    if args.assets:
        args.assets.mkdir(parents=True, exist_ok=True)
        sprites['holding-bent'].save(args.assets / 'holding-bent.webp', lossless=True, method=6)
        module.save(args.assets / 'holding-hand-horn-left.webp', lossless=True, method=6)
    metadata = {'source': args.source.name, 'sha256': hashlib.sha256(args.source.read_bytes()).hexdigest(),
                'sourceSize': source.size, 'regions': regions, 'spriteSizes': sizes}
    (args.output / 'extraction.json').write_text(json.dumps(metadata, indent=2), encoding='utf-8')


if __name__ == '__main__':
    main()
