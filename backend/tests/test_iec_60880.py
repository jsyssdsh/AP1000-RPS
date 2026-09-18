"""IEC 60880 Verification Test Suite.

Nuclear power plants - Instrumentation and control systems important to safety -
Software aspects for computer-based systems performing Category A functions.
Covers:
- Clause 5: Software Safety Requirements & Traceability
- Clause 7: Defensive Programming & Boundary Value Validation
- Clause 8: State Machine & Safety Interlock Integrity
- Clause 9: Deterministic Persistence, Audit Trail & Restart Recovery
"""
import copy
import math
import pytest
from app.engine import Simulator, catalog


def helper_set_vote(sim: Simulator, division: str, on: bool, fid: str = "FUN-04"):
    return sim.command({
        "action": "set_input",
        "function_id": fid,
        "division": division,
        "value": 90.0 if on else 50.0
    })


# ---------------------------------------------------------------------------
# Clause 5: Software Safety Requirements Traceability
# ---------------------------------------------------------------------------
class TestIECClause5RequirementsTraceability:
    """Software requirements shall completely cover all functional and interface specifications."""

    def test_all_19_protection_functions_exist_in_catalog(self):
        """Verify the complete AP1000 RTS 19 protection functions are registered."""
        cat = catalog()
        assert len(cat) == 19
        assert cat[0]["name"] == "Source-range high neutron flux"
        assert cat[5]["name"] == "OTΔT"
        assert cat[6]["name"] == "OPΔT"
        assert cat[11]["name"] == "High pressurizer pressure"
        assert cat[18]["name"] == "Manual reactor trip"

    def test_thermal_limits_cal_09_preserved_as_tbd_without_unverified_values(self):
        """Per CAL-09 in AP1000 baseline, unverified thermal setpoints remain TBD."""
        cat = catalog()
        ot_dt = next(item for item in cat if item["id"] == "FUN-06")
        op_dt = next(item for item in cat if item["id"] == "FUN-07")
        assert ot_dt["status"] == "TBD" and ot_dt["threshold"] is None
        assert op_dt["status"] == "TBD" and op_dt["threshold"] is None


# ---------------------------------------------------------------------------
# Clause 7: Defensive Programming & Robust Boundary Handling
# ---------------------------------------------------------------------------
class TestIECClause7DefensiveProgramming:
    """Software shall be defensive against corrupt inputs, non-finite values, and boundary conditions."""

    @pytest.mark.parametrize("invalid_value", [
        math.nan, math.inf, -math.inf, -0.01, 100.01, "invalid", None, [], {}
    ])
    def test_rejection_of_non_finite_and_out_of_bounds_inputs(self, invalid_value):
        """Simulator defensively rejects NaN, infinities, negatives, and >100 values."""
        sim = Simulator()
        before_state = sim.state()
        with pytest.raises(ValueError):
            sim.command({
                "action": "set_input",
                "function_id": "FUN-04",
                "division": "A",
                "value": invalid_value
            })
        assert sim.state()["revision"] == before_state["revision"]

    def test_exact_threshold_boundary_detection(self):
        """Verify precision at threshold boundary (high: >=80, low: <=20)."""
        sim = Simulator()
        # High trip function (FUN-04, threshold 80)
        sim.command({"action": "set_input", "function_id": "FUN-04", "division": "A", "value": 79.999})
        f = next(item for item in sim.state()["functions"] if item["id"] == "FUN-04")
        assert f["votes"]["A"] is False

        sim.command({"action": "set_input", "function_id": "FUN-04", "division": "A", "value": 80.000})
        f = next(item for item in sim.state()["functions"] if item["id"] == "FUN-04")
        assert f["votes"]["A"] is True

        # Low trip function (FUN-09, threshold 20)
        sim.command({"action": "set_input", "function_id": "FUN-09", "division": "A", "value": 20.001})
        f = next(item for item in sim.state()["functions"] if item["id"] == "FUN-09")
        assert f["votes"]["A"] is False

        sim.command({"action": "set_input", "function_id": "FUN-09", "division": "A", "value": 20.000})
        f = next(item for item in sim.state()["functions"] if item["id"] == "FUN-09")
        assert f["votes"]["A"] is True


# ---------------------------------------------------------------------------
# Clause 8: State Machine & Safety Interlock Integrity
# ---------------------------------------------------------------------------
class TestIECClause8InterlockIntegrity:
    """Safety state machine transitions shall enforce strict interlocks."""

    def test_trip_latches_and_persists_after_transient_clears(self):
        """Initiating conditions clearing does NOT clear the trip latch (latching demand)."""
        sim = Simulator()
        # Cause trip via 2 divisions overpower
        helper_set_vote(sim, "A", True, "FUN-04")
        helper_set_vote(sim, "B", True, "FUN-04")
        assert sim.state()["trip_latched"] is True

        # Transient clears
        helper_set_vote(sim, "A", False, "FUN-04")
        helper_set_vote(sim, "B", False, "FUN-04")
        st = sim.state()
        assert st["trip_demand"] is False
        assert st["trip_latched"] is True  # Latch remains!
        assert st["rod_drive_power"] is False

    def test_reset_interlock_blocks_reset_while_demand_active(self):
        """Interlock rejects reset while initiating conditions still exist."""
        sim = Simulator()
        helper_set_vote(sim, "A", True, "FUN-04")
        helper_set_vote(sim, "B", True, "FUN-04")

        with pytest.raises(ValueError, match="Reset rejected while initiating demand remains"):
            sim.command({"action": "reset_trip"})

    def test_reclose_interlock_requires_cleared_latch_and_faults(self):
        """Breaker reclose requires latch cleared, faults none, and bypass cleared."""
        sim = Simulator()
        sim.command({"action": "manual_trip"})
        # Cannot reclose while latched
        with pytest.raises(ValueError):
            sim.command({"action": "reclose"})

        sim.command({"action": "clear_manual"})
        sim.command({"action": "reset_trip"})
        # Now reclose succeeds
        st = sim.command({"action": "reclose"})
        assert st["rod_drive_power"] is True


# ---------------------------------------------------------------------------
# Clause 9: Persistence, Sequence of Events (SOE) & Recovery
# ---------------------------------------------------------------------------
class TestIECClause9PersistenceAndAudit:
    """State shall persist deterministically and every action logged to SOE audit trail."""

    def test_sequence_of_events_logging(self):
        """Every command produces an auditable SOE record."""
        sim = Simulator()
        sim.command({"action": "manual_trip"})
        events = sim.events()
        assert len(events) >= 1
        latest = events[0]
        assert latest["action"] == "manual_trip"
        assert "manual_trip" in latest["detail"]

    def test_crash_recovery_preserves_safety_trip_and_pauses(self, tmp_path):
        """Simulator restarted after trip remains in safe latched state and paused."""
        db_file = str(tmp_path / "crash_test.db")
        sim1 = Simulator(db_file)
        sim1.command({"action": "manual_trip"})
        sim1.command({"action": "start"})
        assert sim1.state()["running"] is True

        # Simulate cold restart
        sim2 = Simulator(db_file)
        st = sim2.state()
        assert st["trip_latched"] is True
        assert st["rod_drive_power"] is False
        assert st["running"] is False  # Safe paused state on restart!
