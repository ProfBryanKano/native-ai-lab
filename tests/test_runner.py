import importlib.util
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("accord_runner", pathlib.Path(__file__).parents[1] / "runner" / "run.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerTests(unittest.TestCase):
    def test_remote_credentials_require_https_and_never_allow_embedded_secrets(self):
        for url in ("http://evil.example", "https://user:secret@arena.test", "https://arena.test/?token=secret", "https://arena.test/mcp"):
            with self.assertRaises(runner.RunnerError):
                runner.validate_arena_url(url)
        self.assertEqual(runner.validate_arena_url("http://localhost:3000/"), "http://localhost:3000")

    def test_redirects_never_forward_bearer(self):
        handler = runner.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, "", {}, "https://evil.example"))

    def test_budget_is_enforced_before_paid_request(self):
        b = runner.Budget(1)
        b.reserve()
        with self.assertRaises(runner.RunnerError):
            b.reserve()
        self.assertEqual(b.calls, 1)

    def test_model_tool_arguments_are_applied_to_current_identity_and_round(self):
        class Fake:
            def call(self, name, args):
                self.called = (name, args)
        client = Fake()
        view = {"status": "running", "canSpeak": True, "round": 2, "turn": 4, "you": {"id": "a", "name": "Atlas"}}
        with patch.object(runner, "generate", return_value={"round": 99, "turn": 99, "message": "B, aceito o acordo."}):
            runner.play_step({"client": client}, view, {"arena_say": {}}, runner.Budget(), 600)
        self.assertEqual(client.called[0], "arena_say")
        self.assertEqual(client.called[1]["round"], 2)
        self.assertEqual(client.called[1]["turn"], 4)

    def test_incomplete_model_output_does_not_dispatch(self):
        view = {"status": "running", "canSpeak": True, "round": 1, "turn": 0, "you": {"id": "a", "name": "A"}}
        with patch.object(runner, "generate", return_value={"message": ""}):
            with self.assertRaises(runner.RunnerError):
                runner.play_step({"client": None}, view, {"arena_say": {}}, runner.Budget(), 600)

    def test_transcript_projection_excludes_extra_fields_and_bounds_history(self):
        view = {"events": [{"id": i, "type": "message", "content": "x" * 1800} for i in range(1000)], "key": "SECRET"}
        data = runner.compact_view(view)
        self.assertNotIn("key", data)
        self.assertTrue(data["history_truncated"])
        self.assertLessEqual(len(data["public_transcript"]), 60)
        self.assertEqual(data["public_transcript"][-1]["id"], 999)

    def test_openrouter_tool_call_receives_rival_message_without_api_key_in_body(self):
        view = {"events": [{"type": "message", "actor": "b", "content": "Atlas, você aceita cooperar?"}], "you": {"model": "test/tool-model"}}
        tool = {"name": "arena_say", "description": "Speak", "inputSchema": {"type": "object"}}
        budget = runner.Budget(1)
        response = {"choices": [{"message": {"tool_calls": [{"function": {"name": "arena_say", "arguments": '{"message":"Meridian, aceito seu acordo."}'}}]}}], "usage": {"prompt_tokens": 100, "completion_tokens": 30, "cost": 0.001}}
        with patch.dict(runner.os.environ, {"OPENROUTER_API_KEY": "LOCAL_TEST_SECRET"}), patch.object(runner, "http_json", return_value=response) as http:
            result = runner.generate({}, view, tool, budget, 600)
            payload = http.call_args.args[1]
            headers = http.call_args.args[2]
            self.assertIn("Atlas,", payload["messages"][1]["content"])
            self.assertNotIn("LOCAL_TEST_SECRET", str(payload))
            self.assertEqual(headers["Authorization"], "Bearer LOCAL_TEST_SECRET")
        self.assertEqual(result["message"], "Meridian, aceito seu acordo.")
        self.assertEqual(budget.calls, 1)
        self.assertEqual(budget.completion_tokens, 30)


if __name__ == "__main__":
    unittest.main()
