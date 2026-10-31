"""Check the shipped pose atlas; run with Python, Pillow and NumPy."""
from pathlib import Path
import sys
import unittest

import numpy as np
from PIL import Image


ASSET = Path(__file__).resolve().parents[1] / 'web_controller/assets/banban/login-motion.webp'
if len(sys.argv) > 1 and not sys.argv[1].startswith('-'):
    ASSET = Path(sys.argv.pop(1)).resolve()


class AuthKeyposesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        atlas = Image.open(ASSET).convert('RGBA')
        if atlas.size != (660, 480):
            raise AssertionError(f'Expected six 220x240 cells, got {atlas.size}')
        cls.frames = [np.asarray(atlas.crop((i % 3 * 220, i // 3 * 240,
                                            i % 3 * 220 + 220, i // 3 * 240 + 240)))
                      for i in range(6)]

    def test_exposed_upper_left_spine_does_not_change_with_the_pose(self):
        # The hands do not reach this part of the book in any authored pose.
        # Compare poses to each other, without a frozen screenshot or hash.
        reference = self.frames[0][40:65, 30:56]
        for i, frame in enumerate(self.frames[1:], 1):
            with self.subTest(pose=i):
                self.assertTrue(np.array_equal(reference, frame[40:65, 30:56]),
                                f'Pose {i} changes the exposed upper-left book spine')

    def test_eye_and_hand_poses_remain_distinct(self):
        for i, frame in enumerate(self.frames):
            for j, other in enumerate(self.frames[:i]):
                with self.subTest(poses=(j, i)):
                    self.assertGreater(np.abs(frame[65:165].astype(float)
                                              - other[65:165].astype(float)).mean(), .5)

    def test_each_pose_keeps_a_transparent_margin(self):
        for i, frame in enumerate(self.frames):
            with self.subTest(pose=i):
                border = np.concatenate((frame[0, :, 3], frame[-1, :, 3],
                                         frame[:, 0, 3], frame[:, -1, 3]))
                self.assertFalse(border.any(), f'Pose {i} touches the edge of its cell')


if __name__ == '__main__':
    unittest.main()
