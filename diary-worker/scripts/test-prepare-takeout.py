import importlib.util
import hashlib
import io
import pathlib
import subprocess
import sys
import tempfile
import unittest
import zipfile

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

    def test_2024_split_zip64_metadata_year_filter_and_stable_resume(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as folder:
            source = pathlib.Path(folder)
            output = source / 'prepared' / 'package'
            dates = ['2024-01-01', '2024-02-29', '2024-12-31', '2025-01-01']
            originals = {}
            # Tiny synthetic ZIP64 entries exercise the reader without multi-GB test files.
            with zipfile.ZipFile(source / 'takeout-fixture-001.zip', 'w') as images, \
                    zipfile.ZipFile(source / 'takeout-fixture-002.zip', 'w') as metadata:
                for index, date in enumerate(dates):
                    name = f'Takeout/Google Photos/fixture/{index}.png'
                    stream = io.BytesIO()
                    Image.new('RGB', (2, 2), (index * 50, 20, 30)).save(stream, format='PNG')
                    originals[name] = stream.getvalue()
                    with images.open(name, 'w', force_zip64=True) as entry:
                        entry.write(originals[name])
                    timestamp = int(module.dt.datetime.fromisoformat(date + 'T00:00:00+09:00').timestamp())
                    metadata.writestr(name + '.json', module.json.dumps({
                        'title': f'{index}.png', 'photoTakenTime': {'timestamp': str(timestamp)}}))
            command = [sys.executable, str(pathlib.Path(module.__file__)), '--source', str(source),
                       '--output', str(output), '--year', '2024']
            subprocess.run(command, check=True, capture_output=True, text=True, timeout=60)
            manifest = module.json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
            self.assertEqual(manifest['year'], 2024)
            self.assertEqual([day['date'] for day in manifest['days']], dates[:3])
            self.assertEqual(len(manifest['excluded']), 1)
            self.assertEqual(manifest['excluded'][0]['reason'], '指定年の範囲外')
            for day in manifest['days']:
                photo = day['photos'][0]
                self.assertEqual(photo['dateSource'], 'google-json')
                raw = (output / photo['original']['path']).read_bytes()
                self.assertEqual(raw, originals[photo['sourceEntry']])
                self.assertEqual(hashlib.sha256(raw).hexdigest(), photo['original']['sha256'])
            # The existing progress file and original manifest must survive re-preparation.
            progress = {'version': 1, 'manifestId': manifest['id'], 'days': {}}
            module.save_json(output / 'migration-progress.json', progress)
            subprocess.run(command, check=True, capture_output=True, text=True, timeout=60)
            self.assertEqual(module.json.loads((output / 'manifest.json').read_text(encoding='utf-8')), manifest)
            self.assertEqual(module.json.loads((output / 'migration-progress.json').read_text(encoding='utf-8')), progress)

    def test_2026_package_excludes_out_of_period_originals_before_conversion(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as folder:
            source = pathlib.Path(folder)
            output = source / 'prepared' / 'package'
            dates_utc = ('2025-12-31T14:59:59+00:00', '2025-12-31T15:00:00+00:00',
                         '2026-07-31T14:59:59+00:00', '2026-07-31T15:00:00+00:00')
            with zipfile.ZipFile(source / 'takeout-fixture-001.zip', 'w') as images, \
                    zipfile.ZipFile(source / 'takeout-fixture-002.zip', 'w') as metadata:
                for index, date_utc in enumerate(dates_utc):
                    name = f'Takeout/Google Photos/Photos from 2026/{index}.png'
                    stream = io.BytesIO()
                    if index in (1, 2):
                        Image.new('RGB', (2, 2), (index * 50, 20, 30)).save(stream, format='PNG')
                    else:
                        # A valid capture date lets the worker skip even undecodable bytes.
                        stream.write(b'invalid image outside migration period')
                    images.writestr(name, stream.getvalue())
                    timestamp = int(module.dt.datetime.fromisoformat(date_utc).timestamp())
                    metadata.writestr(name + '.supplemental-metadata.json', module.json.dumps({
                        'title': f'{index}.png', 'photoTakenTime': {'timestamp': str(timestamp)}}))
                for label, date in [('exif-july', '2026:07:31 12:00:00'), ('exif-august', '2026:08:01 00:00:00')]:
                    exif = Image.Exif()
                    exif[36867] = date
                    exif[36881] = '+09:00'
                    stream = io.BytesIO()
                    Image.new('RGB', (2, 2), (20, 30, 100)).save(stream, format='JPEG', exif=exif)
                    images.writestr(f'Takeout/Google Photos/Photos from 2026/{label}.jpg', stream.getvalue())

            command = [sys.executable, str(pathlib.Path(module.__file__)), '--source', str(source),
                       '--output', str(output), '--year', '2026']
            subprocess.run(command, check=True, capture_output=True, text=True, timeout=60)
            manifest = module.json.loads((output / 'manifest.json').read_text(encoding='utf-8'))
            self.assertEqual([day['date'] for day in manifest['days']], ['2026-01-01', '2026-07-31'])
            self.assertEqual([[photo['fileName'] for photo in day['photos']] for day in manifest['days']],
                             [['1.png'], ['exif-july.jpg', '2.png']])
            self.assertEqual([item['reason'] for item in manifest['excluded']],
                             ['指定年の範囲外', '2026年1月1日〜7月31日の範囲外', '2026年1月1日〜7月31日の範囲外'])
            self.assertEqual(len(list((output / 'photos').glob('*/*'))), 9)


if __name__ == '__main__':
    unittest.main()
