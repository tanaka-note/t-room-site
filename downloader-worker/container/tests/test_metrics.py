import unittest
from unittest.mock import patch
from scanner import cgroup_cpu, measure_phase


class MetricsTests(unittest.TestCase):
    def test_cpu_reads_cgroup_user_and_system_including_live_processes(self):
        with patch('scanner.Path.read_text', return_value='usage_usec 5000000\nuser_usec 3000000\nsystem_usec 2000000\n'):
            self.assertEqual(cgroup_cpu(), (3.0, 2.0))

    def test_unavailable_cpu_is_not_reported_as_zero(self):
        wall, cpu = {}, {}
        with patch('scanner.cgroup_cpu', return_value=None):
            with measure_phase(wall, 'clamavNormal', cpu):
                pass
        self.assertIn('clamavNormal', wall)
        self.assertNotIn('clamavNormal', cpu)

    def test_failed_phases_still_record_elapsed_time_and_cpu(self):
        wall, cpu = {}, {}
        with patch('scanner.cgroup_cpu', side_effect=[(1, 2), (2, 4)]):
            with self.assertRaises(ValueError):
                with measure_phase(wall, 'clamavNormal', cpu):
                    raise ValueError('fixture')
        self.assertEqual(cpu['clamavNormal'], 3000)
        self.assertIn('clamavNormal', wall)
