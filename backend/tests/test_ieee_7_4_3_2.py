"""IEEE 7-4.3.2 Verification Test Suite.

Standard Criteria for Digital Computers in Safety Systems of Nuclear Power Generating Stations.
Covers:
- Clause 5.1: Single Failure Criterion
- Clause 5.3: Independence and Non-Interference
- Clause 5.5: Deterministic Timing and Bounded Cycles
- Clause 5.7: Fail-Safe State upon Loss of Power / Comms
- Clause 5.9: Maintenance Bypass Interlocks
"""
import copy
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
# Clause 5.1: Single Failure Criterion
# ---------------------------------------------------------------------------
class TestIEEEClause51SingleFailureCriterion:
    """A single random failure shall not prevent the safety group from performing its safety function."""

    def test_single_stuck_breaker_does_not_prevent_rod_drive_power_cutoff(self):
        """Single stuck breaker in Division A: Opening breakers in B and C still removes rod drive power."""
        sim = Simulator()
        sim.command({"action": "fault", "division": "A", "fault": "breaker_stuck"})
        # 2 divisions detect overpower trip demand
        helper_set_vote(sim, "B", True)
        helper_set_vote(sim, "C", True)
        st = sim.state()

        assert st["trip_demand"] is True
        assert st["trip_latched"] is True
        # Division A CB1 is stuck closed, but CB2 is open
        assert st["divisions"][0]["breakers_open"] == [False, True]
        # Divisions B, C, D breakers are all open
        assert st["divisions"][1]["breakers_open"] == [True, True]
        assert st["divisions"][2]["breakers_open"] == [True, True]
        # Rod drive power is removed (gravity trip succeeds)
        assert st["rod_drive_power"] is False

    @pytest.mark.parametrize("failed_div", ["A", "B", "C", "D"])
    def test_single_division_sensor_failure_does_not_prevent_trip(self, failed_div):
        """Sensor failure on any single division does not prevent trip when 2 other divisions sense condition."""
        sim = Simulator()
        sim.command({"action": "fault", "division": failed_div, "fault": "sensor_bad"})

        other_divs = [d for d in "ABCD" if d != failed_div][:2]
        helper_set_vote(sim, other_divs[0], True)
        helper_set_vote(sim, other_divs[1], True)

        st = sim.state()
        assert st["trip_demand"] is True
        assert st["rod_drive_power"] is False

    def test_spurious_single_channel_trip_does_not_cause_reactor_trip(self):
        """A single spurious channel trip does NOT cause an inadvertent plant trip (2oo4 immunity)."""
        sim = Simulator()
        helper_set_vote(sim, "A", True)
        st = sim.state()

        # Division A has partial trip, but no coincidence trip
        assert st["divisions"][0]["partial_trip"] is True
        assert st["trip_demand"] is False
        assert st["trip_latched"] is False
        assert st["rod_drive_power"] is True


# ---------------------------------------------------------------------------
# Clause 5.3: Independence and Non-Interference
# ---------------------------------------------------------------------------
class TestIEEEClause53Independence:
    """Redundant divisions shall be physically and electrically independent."""

    def test_divisions_have_isolated_input_state(self):
        """Setting input on Division A has zero side-effects on Divisions B, C, and D."""
        sim = Simulator()
        helper_set_vote(sim, "A", True, "FUN-04")
        st = sim.state()

        f = next(item for item in st["functions"] if item["id"] == "FUN-04")
        assert f["votes"]["A"] is True
        assert f["votes"]["B"] is False
        assert f["votes"]["C"] is False
        assert f["votes"]["D"] is False

    def test_no_cross_function_voting_interference(self):
        """Single votes in different protection functions cannot combine to trigger a trip."""
        sim = Simulator()
        helper_set_vote(sim, "A", True, "FUN-04")  # Power range high flux
        helper_set_vote(sim, "B", True, "FUN-12")  # High pressurizer pressure
        helper_set_vote(sim, "C", True, "FUN-09")  # Low reactor coolant flow
        st = sim.state()

        assert st["trip_demand"] is False
        assert st["trip_latched"] is False
        assert st["rod_drive_power"] is True


# ---------------------------------------------------------------------------
# Clause 5.5: Deterministic Execution and Real-Time Timing
# ---------------------------------------------------------------------------
class TestIEEEClause55DeterministicTiming:
    """Safety functions shall execute within deterministic, bounded cycle times."""

    def test_step_execution_is_bounded_and_monotonic(self):
        """Step commands increment tick monotonically and maintain history bounds."""
        sim = Simulator()
        initial_tick = sim.state()["tick"]
        for i in range(10):
            sim.command({"action": "step"})
        st = sim.state()
        assert st["tick"] == initial_tick + 10
        assert len(st["history"]) == 10

    def test_atomic_state_transitions(self):
        """Any rejected command leaves the simulator state completely unmodified."""
        sim = Simulator()
        before = copy.deepcopy(sim.state())
        with pytest.raises(ValueError):
            sim.command({"action": "invalid_command_xyz"})
        after = sim.state()
        assert before["revision"] == after["revision"]
        assert before["tick"] == after["tick"]


# ---------------------------------------------------------------------------
# Clause 5.7: Fail-Safe State upon Loss of Power / Signal
# ---------------------------------------------------------------------------
class TestIEEEClause57FailSafeState:
    """Components shall fail to the safe state (de-energize to trip)."""

    def test_power_loss_division_fails_to_tripped_and_uv_deenergized(self):
        """Loss of power to Division A immediately opens its breakers and de-energizes UV coil."""
        sim = Simulator()
        st = sim.command({"action": "fault", "division": "A", "fault": "power_loss"})
        div_a = st["divisions"][0]

        assert div_a["uv_energized"] is False
        assert div_a["shunt_energized"] is True
        assert div_a["breakers_open"] == [True, True]

    def test_dual_division_power_loss_trips_reactor_failsafe(self):
        """Simultaneous loss of power to two divisions directly removes rod drive power."""
        sim = Simulator()
        sim.command({"action": "fault", "division": "A", "fault": "power_loss"})
        st = sim.command({"action": "fault", "division": "B", "fault": "power_loss"})

        assert st["rod_drive_power"] is False


# ---------------------------------------------------------------------------
# Clause 5.9: Maintenance Bypass Interlocks
# ---------------------------------------------------------------------------
class TestIEEEClause59BypassInterlocks:
    """Bypasses shall be monitored and interlocked to preserve safety capability."""

    def test_single_bypass_transitions_voting_to_2oo3(self):
        """Bypassing Division A transitions coincidence voting from 2oo4 to 2oo3."""
        sim = Simulator()
        st = sim.command({"action": "bypass", "division": "A", "enabled": True})
        assert st["voting"] == "2oo3"
        assert st["bypass"] == "A"

        # Under 2oo3, 2 votes among B, C, D trigger trip
        helper_set_vote(sim, "B", True)
        assert sim.state()["trip_demand"] is False
        helper_set_vote(sim, "C", True)
        assert sim.state()["trip_demand"] is True

    def test_simultaneous_second_bypass_strictly_rejected(self):
        """Safety interlock rejects bypassing a second division while one is already bypassed."""
        sim = Simulator()
        sim.command({"action": "bypass", "division": "A", "enabled": True})
        with pytest.raises(ValueError, match="Only one division may be bypassed"):
            sim.command({"action": "bypass", "division": "B", "enabled": True})
        assert sim.state()["bypass"] == "A"

    def test_bypass_blocked_when_trip_demand_is_active(self):
        """Safety interlock prevents activating bypass during active trip demand."""
        sim = Simulator()
        helper_set_vote(sim, "A", True)
        helper_set_vote(sim, "B", True)
        assert sim.state()["trip_demand"] is True

        with pytest.raises(ValueError):
            sim.command({"action": "bypass", "division": "C", "enabled": True})
