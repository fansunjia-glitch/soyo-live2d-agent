from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from pydantic import ValidationError

from backend.app.performance import (
    AgentAction,
    AgentEmotion,
    CharacterAnchor,
    CueChannel,
    GazeTarget,
    PerformancePlan,
    SpeechAnchor,
    TimeAnchor,
    normalize_performance_plan,
)


def canonical_plan(**updates: object) -> dict:
    value: dict = {
        "schemaVersion": 2,
        "turnId": "turn-001",
        "reply": "嗯，我明白了。",
        "ttsInstruction": "轻柔、自然。",
        "affect": {
            "primary": "worried",
            "secondary": "shy",
            "intensity": 0.7,
            "secondaryWeight": 0.25,
            "arousal": 0.35,
        },
        "defaultGaze": "user",
        "cues": [
            {
                "cueId": "nod-at-start",
                "channel": "gesture",
                "anchor": {"kind": "speech", "event": "start", "offsetMs": 0},
                "action": "nod",
                "intensity": 0.8,
                "durationMs": 900,
                "priority": "speech",
            },
            {
                "cueId": "look-away",
                "channel": "gaze",
                "anchor": {"kind": "character", "charIndex": 2},
                "gaze": "away",
                "intensity": 0.55,
            },
            {
                "cueId": "settle-expression",
                "channel": "expression",
                "anchor": {"kind": "time", "atMs": 800},
                "emotion": "shy",
                "intensity": 0.4,
            },
        ],
    }
    value.update(updates)
    return value


class PerformancePlanContractTests(unittest.TestCase):
    def test_validates_and_serializes_canonical_v2_plan(self) -> None:
        plan = PerformancePlan.model_validate(canonical_plan())

        self.assertEqual(plan.schema_version, 2)
        self.assertEqual(plan.affect.primary, AgentEmotion.WORRIED)
        self.assertEqual(plan.default_gaze, GazeTarget.USER)
        self.assertIsInstance(plan.cues[0].anchor, SpeechAnchor)
        self.assertIsInstance(plan.cues[1].anchor, CharacterAnchor)
        self.assertIsInstance(plan.cues[2].anchor, TimeAnchor)

        encoded = plan.model_dump(mode="json", by_alias=True, exclude_none=True)
        self.assertEqual(encoded["schemaVersion"], 2)
        self.assertEqual(encoded["cues"][0]["durationMs"], 900)
        self.assertEqual(encoded["affect"]["secondaryWeight"], 0.25)

    def test_rejects_unknown_enums(self) -> None:
        payload = canonical_plan()
        payload["affect"] = {"primary": "ecstatic", "intensity": 0.8, "arousal": 0.7}
        with self.assertRaises(ValidationError):
            PerformancePlan.model_validate(payload)

        payload = canonical_plan()
        payload["cues"][0]["action"] = "dance"
        with self.assertRaises(ValidationError):
            PerformancePlan.model_validate(payload)

    def test_rejects_out_of_range_or_coerced_intensity(self) -> None:
        for value in (-0.01, 1.01, "0.7", True):
            with self.subTest(value=value):
                payload = canonical_plan()
                payload["affect"] = {"primary": "happy", "intensity": value, "arousal": 0.5}
                with self.assertRaises(ValidationError):
                    PerformancePlan.model_validate(payload)

    def test_validates_secondary_emotion_blending(self) -> None:
        invalid_affects = [
            {
                "primary": "happy",
                "intensity": 0.7,
                "secondaryWeight": 0.2,
                "arousal": 0.5,
            },
            {
                "primary": "happy",
                "secondary": "happy",
                "intensity": 0.7,
                "secondaryWeight": 0.2,
                "arousal": 0.5,
            },
            {
                "primary": "happy",
                "secondary": "shy",
                "intensity": 0.7,
                "secondaryWeight": 0.0,
                "arousal": 0.5,
            },
            {
                "primary": "happy",
                "secondary": "shy",
                "intensity": 0.7,
                "secondaryWeight": 0.7,
                "arousal": 0.5,
            },
        ]
        for affect in invalid_affects:
            with self.subTest(affect=affect):
                with self.assertRaises(ValidationError):
                    PerformancePlan.model_validate(canonical_plan(affect=affect))

    def test_requires_exactly_one_payload_matching_the_channel(self) -> None:
        payload = canonical_plan()
        payload["cues"] = [
            {
                "cueId": "bad",
                "channel": "gesture",
                "anchor": {"kind": "speech", "event": "start"},
                "emotion": "happy",
                "intensity": 1.0,
            }
        ]
        with self.assertRaises(ValidationError):
            PerformancePlan.model_validate(payload)

        payload["cues"][0]["action"] = "nod"
        with self.assertRaises(ValidationError):
            PerformancePlan.model_validate(payload)

    def test_validates_anchor_shape_and_numeric_types(self) -> None:
        invalid_anchors = [
            {"kind": "speech", "event": "middle"},
            {"kind": "speech", "event": "start", "offsetMs": 10_001},
            {"kind": "character", "charIndex": -1},
            {"kind": "character", "charIndex": True},
            {"kind": "time", "atMs": "500"},
            {"kind": "beat", "index": 0},
        ]
        for anchor in invalid_anchors:
            with self.subTest(anchor=anchor):
                payload = canonical_plan()
                payload["cues"] = [
                    {
                        "cueId": "invalid-anchor",
                        "channel": "gesture",
                        "anchor": anchor,
                        "action": "nod",
                        "intensity": 1.0,
                    }
                ]
                with self.assertRaises(ValidationError):
                    PerformancePlan.model_validate(payload)

    def test_rejects_character_anchor_past_reply(self) -> None:
        payload = canonical_plan(reply="短句")
        payload["cues"] = [
            {
                "cueId": "too-late",
                "channel": "gesture",
                "anchor": {"kind": "character", "charIndex": 3},
                "action": "nod",
                "intensity": 1.0,
            }
        ]
        with self.assertRaisesRegex(ValidationError, "exceeds reply length"):
            PerformancePlan.model_validate(payload)

    def test_rejects_duplicate_cue_ids_and_unknown_fields(self) -> None:
        payload = canonical_plan()
        payload["cues"] = [payload["cues"][0], dict(payload["cues"][0])]
        with self.assertRaisesRegex(ValidationError, "cueId values must be unique"):
            PerformancePlan.model_validate(payload)

        with self.assertRaises(ValidationError):
            PerformancePlan.model_validate(canonical_plan(rawParameter="ParamAngleX"))


class PerformancePlanNormalizationTests(unittest.TestCase):
    def test_normalizes_current_agent_reply_without_losing_intent(self) -> None:
        plan = normalize_performance_plan(
            {
                "reply": "你好，我在这里。",
                "emotion": "happy",
                "action": "wave",
                "ttsInstruction": "温柔地说。",
                "memorySummary": "这是旧接口的其他返回字段。",
                "messagesCompacted": False,
            },
            turn_id="turn-legacy",
        )

        self.assertEqual(plan.schema_version, 2)
        self.assertEqual(plan.turn_id, "turn-legacy")
        self.assertEqual(plan.affect.primary, AgentEmotion.HAPPY)
        self.assertEqual(len(plan.cues), 1)
        self.assertEqual(plan.cues[0].channel, CueChannel.GESTURE)
        self.assertEqual(plan.cues[0].action, AgentAction.WAVE)
        self.assertIsInstance(plan.cues[0].anchor, SpeechAnchor)

    def test_normalizes_legacy_strength_duration_and_gaze(self) -> None:
        plan = normalize_performance_plan(
            {
                "reply": "让我想想。",
                "emotion": "worried",
                "emotionIntensity": 0.6,
                "action": "think",
                "actionIntensity": 0.75,
                "actionDurationMs": 1_400,
                "gaze": "down",
                "ttsInstruction": "稍微迟疑。",
            },
            turn_id="turn-details",
        )

        self.assertEqual(plan.affect.intensity, 0.6)
        self.assertEqual(plan.default_gaze, GazeTarget.DOWN)
        self.assertEqual(plan.cues[0].intensity, 0.75)
        self.assertEqual(plan.cues[0].duration_ms, 1_400)

    def test_normalizes_v2_wrapper_and_shorthand_beats(self) -> None:
        plan = normalize_performance_plan(
            {
                "reply": "嗯，谢谢你。",
                "emotion": "shy",
                "action": "idle",
                "ttsInstruction": "轻轻地说。",
                "performance": {
                    "schemaVersion": 2,
                    "turnId": "turn-wrapper",
                    "affect": {
                        "primary": "shy",
                        "secondary": "happy",
                        "intensity": 0.65,
                        "secondaryWeight": 0.2,
                        "arousal": 0.4,
                    },
                    "gaze": "user",
                    "beats": [
                        {"anchor": "speech.start", "gesture": "nod", "intensity": 0.5},
                        {"anchor": {"charIndex": 2}, "emotion": "happy", "intensity": 0.3},
                        {"anchor": {"atMs": 700}, "propId": "tea", "intensity": 1.0},
                    ],
                },
            }
        )

        self.assertEqual(plan.turn_id, "turn-wrapper")
        self.assertEqual([cue.cue_id for cue in plan.cues], ["cue-1", "cue-2", "cue-3"])
        self.assertEqual(
            [cue.channel for cue in plan.cues],
            [CueChannel.GESTURE, CueChannel.EXPRESSION, CueChannel.PROP],
        )
        self.assertIsInstance(plan.cues[0].anchor, SpeechAnchor)
        self.assertIsInstance(plan.cues[1].anchor, CharacterAnchor)
        self.assertIsInstance(plan.cues[2].anchor, TimeAnchor)

    def test_canonical_plan_remains_strict_through_normalizer(self) -> None:
        plan = normalize_performance_plan(canonical_plan())
        self.assertEqual(plan.turn_id, "turn-001")

        payload = canonical_plan()
        payload["schemaVersion"] = 3
        with self.assertRaisesRegex(ValueError, "unsupported performance schemaVersion"):
            normalize_performance_plan(payload)

    def test_request_turn_id_is_authoritative_for_every_input_shape(self) -> None:
        canonical = canonical_plan(turnId="model-canonical-turn")
        wrapper = {
            "turnId": "model-root-turn",
            "reply": "你好。",
            "emotion": "neutral",
            "action": "idle",
            "ttsInstruction": "自然。",
            "performance": {
                "schemaVersion": 2,
                "turnId": "model-nested-turn",
                "affect": {
                    "primary": "neutral",
                    "intensity": 0.5,
                    "secondaryWeight": 0.0,
                    "arousal": 0.5,
                },
                "defaultGaze": "user",
                "cues": [],
            },
        }
        instance = PerformancePlan.model_validate(canonical)

        for payload in (canonical, wrapper, instance):
            with self.subTest(payload_type=type(payload).__name__):
                plan = normalize_performance_plan(payload, turn_id="request-turn")
                self.assertEqual(plan.turn_id, "request-turn")

        self.assertEqual(instance.turn_id, "model-canonical-turn")

    def test_rejects_invalid_legacy_enum_instead_of_silently_falling_back(self) -> None:
        with self.assertRaises(ValidationError):
            normalize_performance_plan(
                {
                    "reply": "测试。",
                    "emotion": "unknown",
                    "action": "idle",
                    "ttsInstruction": "自然。",
                },
                turn_id="turn-invalid",
            )

    def test_rejects_ambiguous_shorthand_cue(self) -> None:
        with self.assertRaisesRegex(ValueError, "exactly one channel"):
            normalize_performance_plan(
                {
                    "reply": "测试。",
                    "emotion": "neutral",
                    "action": "idle",
                    "ttsInstruction": "自然。",
                    "cues": [{"gesture": "nod", "emotion": "happy"}],
                },
                turn_id="turn-ambiguous",
            )

    def test_rejects_conflicting_aliases_and_oversized_cue_lists(self) -> None:
        invalid_performance_values = [
            {"defaultGaze": "user", "gaze": "away", "cues": []},
            {"defaultGaze": "user", "cues": [], "beats": []},
            {
                "defaultGaze": "user",
                "cues": [{"gesture": "nod", "action": "wave"}],
            },
            {
                "defaultGaze": "user",
                "cues": [{"sceneId": "room", "propId": "tea"}],
            },
            {
                "defaultGaze": "user",
                "cues": [
                    {
                        "gesture": "nod",
                        "anchor": {"charIndex": 1, "atMs": 100},
                    }
                ],
            },
            {
                "defaultGaze": "user",
                "cues": [{"gesture": "nod"} for _ in range(33)],
            },
        ]

        for performance in invalid_performance_values:
            with self.subTest(performance=performance):
                with self.assertRaises((TypeError, ValueError)):
                    normalize_performance_plan(
                        {
                            "reply": "测试。",
                            "emotion": "neutral",
                            "action": "idle",
                            "ttsInstruction": "自然。",
                            "performance": {"schemaVersion": 2, **performance},
                        },
                        turn_id="turn-conflict",
                    )


class Live2DModelInspectorTests(unittest.TestCase):
    script = Path(__file__).resolve().parents[2] / "scripts" / "inspect-live2d-model.mjs"

    def test_inspects_complete_cubism2_fixture_in_strict_mode(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "avatar.moc").write_bytes(b"moc")
            (root / "texture.png").write_bytes(b"png")
            (root / "idle.mtn").write_text("PARAM_MOUTH_OPEN_Y=0,1\n", encoding="utf-8")
            (root / "smile.exp.json").write_text(
                json.dumps({"params": [{"id": "PARAM_MOUTH_FORM", "val": 1}]}),
                encoding="utf-8",
            )
            entry = root / "model.json"
            entry.write_text(
                json.dumps(
                    {
                        "model": "avatar.moc",
                        "textures": ["texture.png"],
                        "motions": {"Idle": [{"file": "idle.mtn"}]},
                        "expressions": [{"name": "smile", "file": "smile.exp.json"}],
                        "hit_areas": [{"name": "head", "id": "D_REF.HEAD"}],
                    }
                ),
                encoding="utf-8",
            )

            report = self.run_inspector(entry, "--strict")

        self.assertEqual(report["runtime"], "cubism2")
        self.assertEqual(report["warnings"], [])
        self.assertEqual(report["motions"][0]["group"], "Idle")
        self.assertEqual(report["expressions"][0]["name"], "smile")
        self.assertEqual(report["hitAreas"][0]["name"], "head")
        self.assertIn("PARAM_MOUTH_OPEN_Y", report["parameters"]["discovered"])
        self.assertIn("PARAM_MOUTH_FORM", report["parameters"]["discovered"])

    def test_inspects_complete_cubism4_fixture_in_strict_mode(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "motions").mkdir()
            (root / "expressions").mkdir()
            (root / "avatar.moc3").write_bytes(b"MOC3")
            (root / "texture.png").write_bytes(b"png")
            (root / "motions" / "idle.motion3.json").write_text(
                json.dumps(
                    {
                        "Version": 3,
                        "Curves": [{"Target": "Parameter", "Id": "ParamAngleX", "Segments": []}],
                    }
                ),
                encoding="utf-8",
            )
            (root / "expressions" / "smile.exp3.json").write_text(
                json.dumps({"Type": "Live2D Expression", "Parameters": [{"Id": "ParamMouthForm"}]}),
                encoding="utf-8",
            )
            entry = root / "avatar.model3.json"
            entry.write_text(
                json.dumps(
                    {
                        "Version": 3,
                        "FileReferences": {
                            "Moc": "avatar.moc3",
                            "Textures": ["texture.png"],
                            "Motions": {"Idle": [{"File": "motions/idle.motion3.json"}]},
                            "Expressions": [
                                {"Name": "smile", "File": "expressions/smile.exp3.json"}
                            ],
                        },
                        "Groups": [
                            {"Target": "Parameter", "Name": "LipSync", "Ids": ["ParamMouthOpenY"]}
                        ],
                        "HitAreas": [{"Name": "Head", "Id": "HitAreaHead"}],
                    }
                ),
                encoding="utf-8",
            )

            report = self.run_inspector(entry, "--strict")

        self.assertEqual(report["runtime"], "cubism4")
        self.assertEqual(report["warnings"], [])
        self.assertEqual(report["parameters"]["logical"]["mouthOpen"]["found"], "ParamMouthOpenY")
        self.assertIn("ParamAngleX", report["parameters"]["discovered"])
        self.assertIn("ParamMouthForm", report["parameters"]["discovered"])

    def test_strict_mode_fails_when_required_capabilities_are_missing(self) -> None:
        with TemporaryDirectory() as directory:
            entry = Path(directory) / "model.json"
            entry.write_text(
                json.dumps({"model": "missing.moc", "textures": [], "motions": {}}),
                encoding="utf-8",
            )
            completed = subprocess.run(
                ["node", str(self.script), str(entry), "--strict"],
                check=False,
                capture_output=True,
                text=True,
            )
            report = json.loads(completed.stdout)

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(report["runtime"], "cubism2")
        self.assertTrue(any("No motion groups" in warning for warning in report["warnings"]))
        self.assertTrue(any("No hit areas" in warning for warning in report["warnings"]))
        self.assertTrue(any("Mouth-open parameter" in warning for warning in report["warnings"]))

    def run_inspector(self, entry: Path, *options: str) -> dict:
        completed = subprocess.run(
            ["node", str(self.script), str(entry), *options],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(completed.stdout)


if __name__ == "__main__":
    unittest.main()
