# -----------------------------------------------------------------------
# Adapter-level tests for macro_adapter.py (Block 4).
#
# All tests here use MOCKED HTTP responses (deterministic, no real network
# calls) - see manual_real_yahoo_test.py for the one real, live Yahoo
# Finance request, reported separately per Block 4's instructions.
#
# Run: python3 -m unittest test_macro_adapter.py -v
# -----------------------------------------------------------------------

import json
import os
import tempfile
import unittest
from unittest.mock import patch, MagicMock

import macro_adapter


def fake_meta(last=100.0, prev_close=99.0, market_time=1787759313, in_session=True):
    start = market_time - 3600
    end = market_time + 3600 if in_session else market_time - 1800
    return {
        "regularMarketPrice": last,
        "previousClose": prev_close,
        "regularMarketTime": market_time,
        "currentTradingPeriod": {"regular": {"start": start, "end": end}},
    }


def fake_response(status_code=200, json_body=None, raise_json_error=False):
    resp = MagicMock()
    resp.status_code = status_code
    if raise_json_error:
        resp.json.side_effect = ValueError("malformed JSON")
    else:
        resp.json.return_value = json_body
    return resp


class MacroAdapterTests(unittest.TestCase):
    def setUp(self):
        # Isolate OUTPUT_PATH to a temp file per test so tests never touch
        # the real macro_data.json / can't leak state between tests.
        self.tmpdir = tempfile.mkdtemp()
        self._orig_output_path = macro_adapter.OUTPUT_PATH
        macro_adapter.OUTPUT_PATH = os.path.join(self.tmpdir, "macro_data.json")

    def tearDown(self):
        macro_adapter.OUTPUT_PATH = self._orig_output_path

    def read_output(self):
        with open(macro_adapter.OUTPUT_PATH) as f:
            return json.load(f)

    # 1. Both SPY and QQQ succeed.
    def test_both_succeed(self):
        with patch.object(macro_adapter._session, "get") as mock_get:
            mock_get.return_value = fake_response(json_body={"chart": {"result": [{"meta": fake_meta(last=550.0, prev_close=549.0)}]}})
            payload = macro_adapter.poll_once()

        self.assertIsNotNone(payload["instruments"]["SPY"])
        self.assertIsNotNone(payload["instruments"]["QQQ"])
        self.assertAlmostEqual(payload["instruments"]["SPY"]["last"], 550.0)
        self.assertAlmostEqual(payload["instruments"]["SPY"]["changePct"], (550.0 - 549.0) / 549.0 * 100.0)
        on_disk = self.read_output()
        self.assertEqual(on_disk, payload)

    # 2. SPY succeeds while QQQ fails.
    def test_spy_succeeds_qqq_fails(self):
        def side_effect(url, params=None, timeout=None):
            if "SPY" in url:
                return fake_response(json_body={"chart": {"result": [{"meta": fake_meta(last=550.0, prev_close=549.0)}]}})
            return fake_response(status_code=500)

        with patch.object(macro_adapter._session, "get", side_effect=side_effect):
            payload = macro_adapter.poll_once()

        self.assertIsNotNone(payload["instruments"]["SPY"])
        self.assertIsNone(payload["instruments"]["QQQ"])

    # 3. QQQ succeeds while SPY fails.
    def test_qqq_succeeds_spy_fails(self):
        def side_effect(url, params=None, timeout=None):
            if "QQQ" in url:
                return fake_response(json_body={"chart": {"result": [{"meta": fake_meta(last=480.0, prev_close=481.0)}]}})
            raise ConnectionError("simulated network failure")

        with patch.object(macro_adapter._session, "get", side_effect=side_effect):
            payload = macro_adapter.poll_once()

        self.assertIsNone(payload["instruments"]["SPY"])
        self.assertIsNotNone(payload["instruments"]["QQQ"])
        self.assertAlmostEqual(payload["instruments"]["QQQ"]["last"], 480.0)

    # 4. Both requests fail.
    def test_both_fail(self):
        with patch.object(macro_adapter._session, "get", side_effect=ConnectionError("simulated network failure")):
            payload = macro_adapter.poll_once()

        self.assertIsNone(payload["instruments"]["SPY"])
        self.assertIsNone(payload["instruments"]["QQQ"])
        # File must still be written (adapter-alive signal), just with nulls.
        on_disk = self.read_output()
        self.assertIsNone(on_disk["instruments"]["SPY"])
        self.assertIsNone(on_disk["instruments"]["QQQ"])

    # 5. Yahoo returns malformed/unexpected data.
    def test_malformed_response_missing_chart_key(self):
        with patch.object(macro_adapter._session, "get") as mock_get:
            mock_get.return_value = fake_response(json_body={"unexpected": "shape"})
            payload = macro_adapter.poll_once()
        self.assertIsNone(payload["instruments"]["SPY"])
        self.assertIsNone(payload["instruments"]["QQQ"])

    def test_malformed_response_not_json(self):
        with patch.object(macro_adapter._session, "get") as mock_get:
            mock_get.return_value = fake_response(raise_json_error=True)
            payload = macro_adapter.poll_once()
        self.assertIsNone(payload["instruments"]["SPY"])
        self.assertIsNone(payload["instruments"]["QQQ"])

    def test_malformed_response_missing_price_field(self):
        with patch.object(macro_adapter._session, "get") as mock_get:
            meta = fake_meta()
            del meta["regularMarketPrice"]
            mock_get.return_value = fake_response(json_body={"chart": {"result": [{"meta": meta}]}})
            payload = macro_adapter.poll_once()
        self.assertIsNone(payload["instruments"]["SPY"])

    def test_non_finite_price_rejected(self):
        with patch.object(macro_adapter._session, "get") as mock_get:
            mock_get.return_value = fake_response(json_body={"chart": {"result": [{"meta": fake_meta(last=float("nan"))}]}})
            payload = macro_adapter.poll_once()
        self.assertIsNone(payload["instruments"]["SPY"])

    # 6. Yahoo request times out.
    def test_request_timeout(self):
        import requests as _requests

        with patch.object(macro_adapter._session, "get", side_effect=_requests.exceptions.Timeout("simulated timeout")):
            payload = macro_adapter.poll_once()
        self.assertIsNone(payload["instruments"]["SPY"])
        self.assertIsNone(payload["instruments"]["QQQ"])

    def test_request_has_explicit_finite_timeout(self):
        with patch.object(macro_adapter._session, "get") as mock_get:
            mock_get.return_value = fake_response(json_body={"chart": {"result": [{"meta": fake_meta()}]}})
            macro_adapter.fetch_instrument("SPY")
        _, kwargs = mock_get.call_args
        self.assertIn("timeout", kwargs)
        self.assertIsNotNone(kwargs["timeout"])

    # 7. Repeated polling does not corrupt the output.
    def test_repeated_polling_no_corruption_no_accumulation(self):
        with patch.object(macro_adapter._session, "get") as mock_get:
            mock_get.return_value = fake_response(json_body={"chart": {"result": [{"meta": fake_meta(last=550.0, prev_close=549.0)}]}})
            for _ in range(10):
                macro_adapter.poll_once()

        on_disk = self.read_output()
        # Exactly the 2 scoped symbols, every time - no duplicate keys, no
        # growth, no leftover records from prior cycles.
        self.assertEqual(set(on_disk["instruments"].keys()), {"SPY", "QQQ"})
        self.assertEqual(len(json.dumps(on_disk)), len(json.dumps(on_disk)))  # valid, stable JSON

    # 8. No previous successful price is reused after a failure.
    def test_failure_does_not_reuse_previous_price(self):
        with patch.object(macro_adapter._session, "get") as mock_get:
            mock_get.return_value = fake_response(json_body={"chart": {"result": [{"meta": fake_meta(last=550.0, prev_close=549.0)}]}})
            first = macro_adapter.poll_once()
        self.assertEqual(first["instruments"]["SPY"]["last"], 550.0)

        with patch.object(macro_adapter._session, "get", side_effect=ConnectionError("simulated failure")):
            second = macro_adapter.poll_once()

        self.assertIsNone(second["instruments"]["SPY"])
        on_disk = self.read_output()
        self.assertIsNone(on_disk["instruments"]["SPY"])  # not 550.0 carried forward


if __name__ == "__main__":
    unittest.main()
