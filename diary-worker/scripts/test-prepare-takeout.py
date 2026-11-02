import importlib.util
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare_takeout', pathlib.Path(__file__).with_name('prepare-takeout.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MetadataTests(unittest.TestCase):
    def test_google_timestamp(self):
        self.assertEqual(module.metadata_timestamp([{'photoTakenTime': {'timestamp': '1735657200'}}]), 1735657200)
        self.assertIsNone(module.metadata_timestamp([]))

    def test_conflicting_metadata_does_not_guess(self):
        with self.assertRaises(ValueError):
            module.metadata_timestamp([{'photoTakenTime': {'timestamp': str(i)}} for i in [1, 2]])

    def test_exif_uses_capture_date_and_timezone(self):
        class FakeExif(dict):
            def get_ifd(self, key):
                return {36867: '2025:01:01 00:00:00', 36881: '+09:00'}

        class FakeImage:
            def getexif(self):
                return FakeExif({34665: 1})

        self.assertEqual(module.exif_timestamp(FakeImage()), 1735657200)

    def test_atomic_progress_replaces_complete_json(self):
        with tempfile.TemporaryDirectory() as folder:
            target = pathlib.Path(folder) / 'progress.json'
            module.save_json(target, {'done': 1})
            module.save_json(target, {'done': 2})
            self.assertEqual(module.json.loads(target.read_text(encoding='utf-8')), {'done': 2})
            self.assertFalse(list(pathlib.Path(folder).glob('*.tmp')))


if __name__ == '__main__':
    unittest.main()
