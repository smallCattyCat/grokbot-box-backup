"""Run on TYL via machine Shell to refresh slim ledger from Nutstore authority DB."""
import os, sqlite3
SRC = r"C:\Users\tiany\Nutstore\2\我的坚果云\cMOOC智能学伴自动干预系统\源码\prisma\dev.db"
OUT_DIR = r"C:\Users\tiany\AppData\Local\cmooc-ledger-slim"
OUT = os.path.join(OUT_DIR, "ledger-slim.db")
WANT = [
    "DecisionTapeEntry","AutonomyDecision","ReviewEvent","ScheduledInvocation",
    "ForumPost","BudgetReservation","AutonomyIncident","ExecutionAttempt",
    "ExecutionPermit","ProximalOutcome","CourseOperationGovernancePolicy",
    "AutonomyCourseManifest","OperationSchedule","SemanticRealization",
    "CandidateSet","SchedulingLedger","CourseEvent","AutonomyObservation",
    "WorkbenchRunRecord","WorkbenchEventRecord","AgentPatrolLedger",
    # Autonomy read stubs (also ensured on box by ensure_slim_autonomy_tables.py)
    "ForumSetting","AutonomyPolicy","AutonomyWorkerWakeReceipt",
]
def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)
    conn = sqlite3.connect(SRC)
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    slim = sqlite3.connect(OUT)
    slim.execute("PRAGMA journal_mode=OFF")
    for t in WANT:
        if t not in tables:
            continue
        sql = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()
        if not sql or not sql[0]:
            continue
        slim.execute(sql[0])
        cols = [r[1] for r in conn.execute(f"PRAGMA table_info({t})")]
        col_list = ",".join(cols)
        data = conn.execute(f"SELECT {col_list} FROM {t}").fetchall()
        if data:
            ph = ",".join(["?"] * len(cols))
            slim.executemany(f"INSERT INTO {t} ({col_list}) VALUES ({ph})", data)
        print(f"COPIED {t} {len(data)}")
    slim.commit(); slim.close(); conn.close()
    print("OUT", OUT, "SIZE", os.path.getsize(OUT))
if __name__ == "__main__":
    main()
