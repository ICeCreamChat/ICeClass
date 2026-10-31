"""Register the six Congee login poses; requires Pillow, NumPy and OpenCV.

Usage: python scripts/prepare-auth-keyposes.py SOURCE.png OUTPUT_DIRECTORY
The image service is never called by this script or by the application.
"""
from pathlib import Path
import json
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw


def rgba_warp(image, matrix, size=(440, 480)):
    data = np.asarray(image).astype(np.float32) / 255
    data[:, :, :3] *= data[:, :, 3:4]
    data = np.clip(cv2.warpAffine(data, matrix, size, flags=cv2.INTER_CUBIC,
                                borderMode=cv2.BORDER_CONSTANT), 0, 1)
    alpha = data[:, :, 3:4]
    rgb = np.divide(data[:, :, :3], alpha, out=np.zeros_like(data[:, :, :3]), where=alpha > .001)
    return Image.fromarray(np.uint8(np.clip(np.dstack((rgb, alpha)), 0, 1) * 255 + .5))


def gray(image):
    background = Image.new('RGBA', image.size, 'white')
    return cv2.cvtColor(np.array(Image.alpha_composite(background, image).convert('RGB')), cv2.COLOR_RGB2GRAY)


def upper_spine_masks(poses):
    """Keep one continuous spine above the hand, with the drawn hand in front.

    The old horizontal top mask cut through the visible blue outline. End the
    shared spine underneath each hand instead. Find the actual hand interior
    in this six-pose sheet, then include its ink and antialiased edge by color.
    All masks are baked into the atlas; there is no runtime segmentation.
    """
    seeds = [(45, 300), (90, 250), (100, 240), (130, 200), (130, 190), (110, 280)]
    hands = []
    interiors = []
    for pose, (x, y) in zip(poses, seeds):
        rgba = np.asarray(pose).astype(np.float32)
        red, green, blue, alpha = np.moveaxis(rgba, 2, 0)
        light = np.uint8((red > 155) & (green > 125) & (blue > 100)
                         & (red > blue + 10) & (alpha > 128))
        _, labels, stats, _ = cv2.connectedComponentsWithStats(light, 8)
        label = labels[y, x]
        assert label and 1000 < stats[label, cv2.CC_STAT_AREA] < 12000, 'Hand interior not found'
        interior = np.uint8(labels == label)
        nearby = cv2.dilate(interior, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (19, 19)))
        # Blue spine pixels stay in the shared layer; warm hand ink remains in
        # the foreground, including the translucent pixels outside the book.
        warm = np.clip((red - blue + 65) / 30, 0, 1) * (alpha > 0)
        hands.append(nearby * warm)
        interiors.append(interior)

    masks = [np.zeros((480, 440, 1), np.float32)]
    for interior, hand in zip(interiors[1:], hands[1:]):
        spine = np.zeros((480, 440), np.uint8)
        for x in range(68, 117):
            ys = np.flatnonzero(interior[:, x])
            assert len(ys), 'The hand must occlude the spine at the layer boundary'
            spine[:int((ys[0] + ys[-1]) / 2), x] = 255
        spine = cv2.GaussianBlur(spine, (7, 7), 1).astype(np.float32) / 255
        # Do not copy the resting arm from the reference into a raised pose.
        masks.append((spine * (1 - hand) * (1 - hands[0]))[:, :, None])
    return masks


def prepare(source, destination):
    destination.mkdir(parents=True, exist_ok=True)
    pixels = np.array(Image.open(source).convert('RGBA'))
    _, labels, stats, centers = cv2.connectedComponentsWithStats(np.uint8(pixels[:, :, 3] > 128), 8)
    components = [i for i in range(1, len(stats)) if stats[i, 4] > 10000]
    assert len(components) == 6, 'Expected exactly six complete transparent mascot poses'
    components.sort(key=lambda i: centers[i, 1])
    ordered = []
    for row in range(2):
        ordered.extend(sorted(components[row * 3:(row + 1) * 3], key=lambda i: centers[i, 0]))

    poses = []
    for label in ordered:
        mask = cv2.dilate(np.uint8(labels == label), np.ones((3, 3), np.uint8))
        isolated = pixels.copy()
        isolated[:, :, 3] = np.minimum(np.uint8(np.minimum(pixels[:, :, 3].astype(float) * 255 / 253, 255)), mask * 255)
        isolated[isolated[:, :, 3] == 0, :3] = 0
        x, y, width, height = stats[label, :4]
        red = (isolated[:, :, 0] > 175) & (isolated[:, :, 1] < 125) & (isolated[:, :, 2] < 125) & (isolated[:, :, 3] > 200)
        ys, xs = np.nonzero(red)
        assert len(xs) > 30, 'The original badge marker must remain visible'
        scale = 430 / height
        matrix = np.float32([[scale, 0, 220 - xs.mean() * scale], [0, scale, 28 - y * scale]])
        poses.append(rgba_warp(Image.fromarray(isolated), matrix))

    static = np.zeros((480, 440), np.uint8)
    static[20:125] = 255
    static[392:] = 255
    static[252:339, 184:256] = 255
    sift = cv2.SIFT_create(nfeatures=800)
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    reference_points, reference_desc = sift.detectAndCompute(gray(poses[0]), static)
    aligned = [poses[0]]
    for pose in poses[1:]:
        points, desc = sift.detectAndCompute(gray(pose), static)
        matches = [a for a, b in matcher.knnMatch(desc, reference_desc, k=2) if a.distance < .72 * b.distance]
        assert len(matches) >= 8, 'Insufficient unchanged book/badge features'
        origin = np.float32([points[m.queryIdx].pt for m in matches])
        target = np.float32([reference_points[m.trainIdx].pt for m in matches])
        matrix, inliers = cv2.estimateAffinePartial2D(origin, target, method=cv2.RANSAC, ransacReprojThreshold=2)
        assert matrix is not None and np.count_nonzero(inliers) >= 8
        assert .96 < np.hypot(matrix[0, 0], matrix[1, 0]) < 1.04
        aligned.append(rgba_warp(pose, matrix))

    # The spine's shared layer ends underneath the hand, rather than splicing
    # two different silhouettes across a visible horizontal boundary.
    spine_masks = upper_spine_masks(aligned)
    fixed = np.zeros((480, 440), np.uint8)
    fixed[:120] = 255
    fixed[400:] = 255
    cv2.ellipse(fixed, (220, 292), (35, 40), 0, 0, 360, 255, cv2.FILLED)
    fixed = cv2.GaussianBlur(fixed, (11, 11), 2).astype(np.float32)[:, :, None] / 255
    reference = np.array(aligned[0]).astype(np.float32)
    small = []
    for pose, spine in zip(aligned, spine_masks):
        data = np.array(pose).astype(np.float32)
        shared = np.maximum(fixed, spine)
        image = Image.fromarray(np.uint8(np.clip(reference * shared + data * (1 - shared), 0, 255) + .5))
        small.append(image.resize((220, 240), Image.Resampling.LANCZOS))

    atlas = Image.new('RGBA', (660, 480))
    for i, image in enumerate(small):
        atlas.paste(image, (i % 3 * 220, i // 3 * 240))
    atlas.save(destination / 'login-motion.webp', 'WEBP', lossless=True, method=6, exact=True)
    aligned[0].save(destination / 'login-rest.webp', 'WEBP', lossless=True, method=6, exact=True)
    contact = Image.new('RGB', (6 * 176, 212), '#f8fbff')
    draw = ImageDraw.Draw(contact)
    for i, image in enumerate(small):
        thumb = image.resize((176, 192), Image.Resampling.LANCZOS)
        contact.paste(thumb, (i * 176, 0), thumb)
        draw.text((i * 176 + 8, 196), str(i), fill='#203951')
    contact.save(destination / 'keyposes-review.png')
    report = {'source': str(source), 'frames': 6, 'cell': [220, 240], 'columns': 3,
              'atlas': [660, 480], 'bytes': (destination / 'login-motion.webp').stat().st_size,
              'poses': ['rest', 'prepare', 'closed', 'cover', 'peek', 'return']}
    (destination / 'preparation.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: prepare-auth-keyposes.py SOURCE.png OUTPUT_DIRECTORY')
    prepare(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
