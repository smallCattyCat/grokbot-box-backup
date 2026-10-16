"""Zero-write JSONL conformance sidecar for CourseWorld OASIS ScenePack v1."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import random
import re
import sys
from typing import Any, Mapping, Sequence


CANONICAL_HASH_ALGORITHM = "cmooc-canonical-json-sha256-v1"
REQUEST_SCHEMA = "cmooc.oasis-sidecar-request.v1"
CAPABILITY_SCHEMA = "cmooc.oasis-sidecar-capabilities.v1"
RUN_OUTPUT_SCHEMA = "cmooc.oasis-sidecar-run-output.v1"
SCENE_PACK_SCHEMA = "cmooc.oasis-scene-pack.v1"
RUNTIME_ID = "oasis_contract_reference_v1"
TRANSPORT_VERSION = "cmooc.oasis-sidecar-transport.v1"
MAX_INPUT_BYTES = 256 * 1024
WALL_CLOCK_LIMIT_MS = 10_000
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
REQUEST_ID_PATTERN = re.compile(r"^[a-f0-9]{32}$")
FORBIDDEN_KEYS = {
    "snapshotKey",
    "threadKey",
    "courseKey",
    "authorKey",
    "snapshot_key",
    "thread_key",
    "course_key",
    "author_key",
    "forumText",
    "identity",
    "credential",
    "token",
    "cookie",
    "permit",
    "publish",
}


class SidecarError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _assert_plain_json(value: Any, path: str = "$") -> None:
    if value is None or isinstance(value, (bool, str)):
        return
    if isinstance(value, int):
        if value < -(2**53 - 1) or value > 2**53 - 1:
            raise SidecarError("SIDECAR_UNSAFE_INTEGER")
        return
    if isinstance(value, float):
        raise SidecarError("SIDECAR_FLOAT_NOT_ALLOWED")
    if isinstance(value, list):
        for index, item in enumerate(value):
            _assert_plain_json(item, f"{path}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise SidecarError("SIDECAR_OBJECT_KEY_INVALID")
            if key in FORBIDDEN_KEYS:
                raise SidecarError("SIDECAR_RESTRICTED_FIELD")
            _assert_plain_json(item, f"{path}.{key}")
        return
    raise SidecarError("SIDECAR_JSON_TYPE_INVALID")


def _canonical_json(value: Any) -> str:
    _assert_plain_json(value)
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _protocol_hash(schema_version: str, value: Any) -> str:
    body = (
        f"{CANONICAL_HASH_ALGORITHM}\0{schema_version}\0".encode("utf-8")
        + _canonical_json(value).encode("utf-8")
    )
    return hashlib.sha256(body).hexdigest()


def _hash_list(domain: str, values: Sequence[str]) -> str:
    body = (
        f"{CANONICAL_HASH_ALGORITHM}\0{domain}\0".encode("utf-8")
        + "\n".join(sorted(values)).encode("utf-8")
    )
    return hashlib.sha256(body).hexdigest()


def _record(value: Any, code: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise SidecarError(code)
    return value


def _exact_keys(value: Mapping[str, Any], keys: Sequence[str], code: str) -> None:
    if sorted(value.keys()) != sorted(keys):
        raise SidecarError(code)


def _sha256(value: Any, code: str) -> str:
    if not isinstance(value, str) or len(value) != 64:
        raise SidecarError(code)
    try:
        int(value, 16)
    except ValueError as exc:
        raise SidecarError(code) from exc
    if value.lower() != value:
        raise SidecarError(code)
    return value


def _capabilities() -> dict[str, Any]:
    body: dict[str, Any] = {
        "schemaVersion": CAPABILITY_SCHEMA,
        "runtimeId": "oasis_sidecar_v1",
        "protocolVersion": "v1",
        "conformanceReferenceAvailable": True,
        "nativeOasisAvailable": importlib.util.find_spec("oasis") is not None,
        "supportedScenePackSchemaVersions": [SCENE_PACK_SCHEMA],
        "supportedOperations": ["capabilities", "run_conformance"],
        "executionBoundary": {
            "externalNetworkUsed": False,
            "workspaceWriteCount": 0,
            "scratchWriteCount": 0,
            "evidenceMode": "sidecar_self_report",
            "enforcementMode": "process_contract_only",
        },
    }
    return {**body, "capabilityHash": _protocol_hash(CAPABILITY_SCHEMA, body)}


def _validate_scene_pack(value: Any) -> Mapping[str, Any]:
    scene = _record(value, "SIDECAR_SCENE_PACK_INVALID")
    required_keys = [
        "schemaVersion",
        "sceneTemplateRef",
        "seedSetRef",
        "datasetRef",
        "sourceEvidenceHash",
        "evidenceClass",
        "platformModel",
        "evidenceAnchors",
        "syntheticPopulation",
        "arms",
        "syntheticAssumptions",
        "runConfig",
        "governance",
        "scenePackHash",
    ]
    _exact_keys(scene, required_keys, "SIDECAR_SCENE_PACK_FIELDS_INVALID")
    if scene.get("schemaVersion") != SCENE_PACK_SCHEMA:
        raise SidecarError("SIDECAR_SCENE_PACK_SCHEMA_UNSUPPORTED")
    supplied_hash = _sha256(scene.get("scenePackHash"), "SIDECAR_SCENE_PACK_HASH_INVALID")
    hash_body = {key: item for key, item in scene.items() if key != "scenePackHash"}
    if _protocol_hash(SCENE_PACK_SCHEMA, hash_body) != supplied_hash:
        raise SidecarError("SIDECAR_SCENE_PACK_HASH_MISMATCH")

    governance = _record(scene.get("governance"), "SIDECAR_GOVERNANCE_INVALID")
    expected_false = [
        "externalWritesAllowed",
        "coursePlatformWritesAllowed",
        "interventionEligible",
        "containsForumText",
        "containsIdentity",
        "containsRowLevelKeys",
    ]
    if governance.get("decisionUse") != "research_only" or any(
        governance.get(key) is not False for key in expected_false
    ):
        raise SidecarError("SIDECAR_GOVERNANCE_INVALID")

    population = _record(scene.get("syntheticPopulation"), "SIDECAR_POPULATION_INVALID")
    if population.get("agentCount") != 96 or population.get("threadCount") != 64:
        raise SidecarError("SIDECAR_POPULATION_INVALID")
    archetypes = population.get("archetypes")
    if not isinstance(archetypes, list) or sum(
        int(_record(item, "SIDECAR_ARCHETYPE_INVALID").get("agentCount", -1))
        for item in archetypes
    ) != 96:
        raise SidecarError("SIDECAR_ARCHETYPE_INVALID")

    run_config = _record(scene.get("runConfig"), "SIDECAR_RUN_CONFIG_INVALID")
    seeds = run_config.get("seeds")
    if (
        not isinstance(seeds, list)
        or len(seeds) != 16
        or len(set(seeds)) != 16
        or any(not isinstance(seed, int) or isinstance(seed, bool) or seed < 0 for seed in seeds)
    ):
        raise SidecarError("SIDECAR_SEED_SET_INVALID")
    arms = scene.get("arms")
    if not isinstance(arms, list) or [
        _record(arm, "SIDECAR_ARM_INVALID").get("dailyFacilitationBudget")
        for arm in arms
    ] != [0, 1, 3, 5]:
        raise SidecarError("SIDECAR_ARM_SET_INVALID")
    return scene


def _rng(scene_hash: str, seed: int, arm_id: str) -> random.Random:
    digest = hashlib.sha256(
        f"{RUN_OUTPUT_SCHEMA}\0{scene_hash}\0{seed}\0{arm_id}".encode("utf-8")
    ).digest()
    return random.Random(int.from_bytes(digest[:16], "big"))


def _basis_points(numerator: int, denominator: int) -> int:
    return (numerator * 10_000 + denominator // 2) // denominator


def _single_run(scene: Mapping[str, Any], arm: Mapping[str, Any], seed: int) -> dict[str, Any]:
    scene_hash = str(scene["scenePackHash"])
    arm_id = str(arm["armId"])
    generator = _rng(scene_hash, seed, arm_id)
    anchors = _record(scene["evidenceAnchors"], "SIDECAR_ANCHORS_INVALID")
    assumptions = _record(
        scene["syntheticAssumptions"], "SIDECAR_ASSUMPTIONS_INVALID"
    )
    population = _record(scene["syntheticPopulation"], "SIDECAR_POPULATION_INVALID")
    thread_count = int(population["threadCount"])
    organic_bps = int(anchors["organicResponseBaselineBps"])
    facilitated_bps = int(assumptions["facilitatedReplyProbabilityBps"])
    amplification_bps = int(assumptions["recommendationAmplificationBps"])
    if not all(0 <= value <= 10_000 for value in (organic_bps, facilitated_bps, amplification_bps)):
        raise SidecarError("SIDECAR_ASSUMPTION_RANGE_INVALID")

    responded = {
        index
        for index in range(thread_count)
        if generator.randrange(10_000) < organic_bps
    }
    unresolved = [index for index in range(thread_count) if index not in responded]
    generator.shuffle(unresolved)
    horizon_hours = int(anchors["simulationHorizonHours"])
    episode_days = max(1, math.ceil(horizon_hours / 24))
    daily_budget = int(arm["dailyFacilitationBudget"])
    selected = unresolved[: min(len(unresolved), daily_budget * episode_days)]
    for thread_index in selected:
        if generator.randrange(10_000) < min(10_000, facilitated_bps + amplification_bps):
            responded.add(thread_index)

    reply_edges = 0
    for _thread_index in sorted(responded):
        reply_edges += 1
        if generator.randrange(10_000) < amplification_bps:
            reply_edges += 1
    response_count = len(responded)
    support_gap_count = thread_count - response_count
    trace_body: dict[str, Any] = {
        "scenePackHash": scene_hash,
        "seed": seed,
        "armId": arm_id,
        "threadCount": thread_count,
        "facilitatorActionCount": len(selected),
        "responseCount": response_count,
        "supportGapCount": support_gap_count,
        "peerReplyEdgeCount": reply_edges,
    }
    return {
        **trace_body,
        "responseCoverageBps": _basis_points(response_count, thread_count),
        "supportGapBps": _basis_points(support_gap_count, thread_count),
        "traceHash": _protocol_hash("cmooc.oasis-conformance-trace.v1", trace_body),
    }


def _percentile(values: Sequence[int], percentile: int) -> int:
    ordered = sorted(values)
    if not ordered:
        raise SidecarError("SIDECAR_DISTRIBUTION_EMPTY")
    rank = max(1, math.ceil((percentile / 100) * len(ordered)))
    return ordered[min(len(ordered) - 1, rank - 1)]


def _distribution(values: Sequence[int]) -> dict[str, int]:
    return {
        "p10": _percentile(values, 10),
        "p50": _percentile(values, 50),
        "p90": _percentile(values, 90),
    }


def _run_conformance(scene_value: Any) -> dict[str, Any]:
    scene = _validate_scene_pack(scene_value)
    run_config = _record(scene["runConfig"], "SIDECAR_RUN_CONFIG_INVALID")
    seeds = [int(seed) for seed in run_config["seeds"]]
    arms = [_record(arm, "SIDECAR_ARM_INVALID") for arm in scene["arms"]]
    traces = [
        _single_run(scene, arm, seed)
        for arm in arms
        for seed in seeds
    ]
    summaries: list[dict[str, Any]] = []
    for arm in arms:
        arm_id = str(arm["armId"])
        arm_runs = [trace for trace in traces if trace["armId"] == arm_id]
        summaries.append(
            {
                "armId": arm_id,
                "dailyFacilitationBudget": int(arm["dailyFacilitationBudget"]),
                "seedCount": len(arm_runs),
                "facilitatorActionCount": _distribution(
                    [int(run["facilitatorActionCount"]) for run in arm_runs]
                ),
                "responseCoverageBps": _distribution(
                    [int(run["responseCoverageBps"]) for run in arm_runs]
                ),
                "supportGapBps": _distribution(
                    [int(run["supportGapBps"]) for run in arm_runs]
                ),
                "peerReplyEdgeCount": _distribution(
                    [int(run["peerReplyEdgeCount"]) for run in arm_runs]
                ),
            }
        )
    body: dict[str, Any] = {
        "schemaVersion": RUN_OUTPUT_SCHEMA,
        "runtimeId": RUNTIME_ID,
        "engineMode": "conformance_reference",
        "validityClass": "synthetic_protocol_conformance",
        "scenePackHash": scene["scenePackHash"],
        "sourceEvidenceHash": scene["sourceEvidenceHash"],
        "seedRunCount": len(traces),
        "armSummaries": summaries,
        "traceSetHash": _hash_list(
            "cmooc.oasis-conformance-trace-set.v1",
            [str(trace["traceHash"]) for trace in traces],
        ),
        "executionBoundary": {
            "externalNetworkUsed": False,
            "workspaceWriteCount": 0,
            "scratchWriteCount": 0,
            "evidenceMode": "sidecar_self_report",
            "enforcementMode": "process_contract_only",
        },
        "containsForumText": False,
        "containsIdentity": False,
        "containsRowLevelKeys": False,
        "interventionEligible": False,
    }
    return {**body, "outputHash": _protocol_hash(RUN_OUTPUT_SCHEMA, body)}


def _handle(request_value: Any) -> dict[str, Any]:
    request = _record(request_value, "SIDECAR_REQUEST_INVALID")
    operation = request.get("operation")
    if operation == "capabilities":
        _exact_keys(
            request,
            ["schemaVersion", "operation", "protocolVersion"],
            "SIDECAR_REQUEST_FIELDS_INVALID",
        )
        if request.get("schemaVersion") != REQUEST_SCHEMA or request.get("protocolVersion") != "v1":
            raise SidecarError("SIDECAR_PROTOCOL_UNSUPPORTED")
        return _capabilities()
    if operation == "run_conformance":
        _exact_keys(
            request,
            [
                "schemaVersion",
                "operation",
                "protocolVersion",
                "engineMode",
                "scenePack",
            ],
            "SIDECAR_REQUEST_FIELDS_INVALID",
        )
        if (
            request.get("schemaVersion") != REQUEST_SCHEMA
            or request.get("protocolVersion") != "v1"
            or request.get("engineMode") != "conformance_reference"
        ):
            raise SidecarError("SIDECAR_PROTOCOL_UNSUPPORTED")
        return _run_conformance(request.get("scenePack"))
    raise SidecarError("SIDECAR_OPERATION_UNSUPPORTED")


def _validate_transport_envelope(value: Any) -> Mapping[str, Any]:
    envelope = _record(value, "SIDECAR_TRANSPORT_INVALID")
    _exact_keys(
        envelope,
        [
            "transportVersion",
            "requestId",
            "requestHash",
            "wallClockLimitMs",
            "maxOutputBytes",
            "payload",
        ],
        "SIDECAR_TRANSPORT_FIELDS_INVALID",
    )
    if envelope.get("transportVersion") != TRANSPORT_VERSION:
        raise SidecarError("SIDECAR_TRANSPORT_VERSION_UNSUPPORTED")
    request_id = envelope.get("requestId")
    if not isinstance(request_id, str) or REQUEST_ID_PATTERN.fullmatch(request_id) is None:
        raise SidecarError("SIDECAR_REQUEST_ID_INVALID")
    if envelope.get("wallClockLimitMs") != WALL_CLOCK_LIMIT_MS:
        raise SidecarError("SIDECAR_WALL_CLOCK_LIMIT_INVALID")
    if envelope.get("maxOutputBytes") != MAX_OUTPUT_BYTES:
        raise SidecarError("SIDECAR_OUTPUT_LIMIT_INVALID")
    request_hash = _sha256(envelope.get("requestHash"), "SIDECAR_REQUEST_HASH_INVALID")
    hash_body = {
        "requestId": request_id,
        "wallClockLimitMs": WALL_CLOCK_LIMIT_MS,
        "maxOutputBytes": MAX_OUTPUT_BYTES,
        "payload": envelope.get("payload"),
    }
    if _protocol_hash(TRANSPORT_VERSION, hash_body) != request_hash:
        raise SidecarError("SIDECAR_REQUEST_HASH_MISMATCH")
    return envelope


def _write_response(response: Mapping[str, Any], max_output_bytes: int) -> None:
    encoded = (
        json.dumps(
            response,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")
    if len(encoded) > max_output_bytes:
        raise SidecarError("SIDECAR_OUTPUT_TOO_LARGE")
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def main() -> int:
    raw = sys.stdin.buffer.readline(MAX_INPUT_BYTES + 1)
    if not raw or len(raw) > MAX_INPUT_BYTES or sys.stdin.buffer.read(1):
        raise SidecarError("SIDECAR_INPUT_FRAME_INVALID")
    try:
        request = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SidecarError("SIDECAR_INPUT_JSON_INVALID") from exc
    envelope = _validate_transport_envelope(request)
    response_base = {
        "transportVersion": TRANSPORT_VERSION,
        "requestId": envelope["requestId"],
        "requestHash": envelope["requestHash"],
    }
    try:
        payload = _handle(envelope["payload"])
    except SidecarError as error:
        _write_response(
            {
                **response_base,
                "ok": False,
                "error": {"code": error.code},
            },
            int(envelope["maxOutputBytes"]),
        )
        return 2
    _write_response(
        {**response_base, "ok": True, "payload": payload},
        int(envelope["maxOutputBytes"]),
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SidecarError as error:
        sys.stderr.write(
            json.dumps(
                {"ok": False, "error": {"code": error.code}},
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            )
            + "\n"
        )
        raise SystemExit(2)
