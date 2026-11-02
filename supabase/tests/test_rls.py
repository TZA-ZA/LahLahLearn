"""Security tests for the LahLahLearn database.

Runs the migration on a scratch Postgres (with a small Supabase shim) and checks, user by user,
who can read and change what. Usage:
    python3 supabase/tests/test_rls.py "host=/tmp port=54329 user=postgres"
"""
import json, sys, uuid, pathlib
import psycopg

DSN = sys.argv[1] if len(sys.argv) > 1 else "host=/tmp port=54329 user=postgres"
ROOT = pathlib.Path(__file__).resolve().parents[1]
DB = "lll_rls_test"

with psycopg.connect(DSN + " dbname=postgres", autocommit=True) as c:
    c.execute(f"drop database if exists {DB}")
    c.execute(f"create database {DB}")

conn = psycopg.connect(DSN + f" dbname={DB}", autocommit=True)
conn.execute((ROOT / "tests/supabase_shim.sql").read_text())
for f in sorted((ROOT / "migrations").glob("*.sql")):
    conn.execute(f.read_text())

ok = fail = 0
def check(name, cond):
    global ok, fail
    if cond: ok += 1
    else:
        fail += 1
        print("FAIL:", name)

users = {}
for key, email in [("pa", "amina@example.com"), ("pb", "ben@example.com"), ("t", "teacher@school.my"),
                   ("r", "therapist@clinic.my"), ("s", "stranger@example.com")]:
    uid = str(uuid.uuid4())
    conn.execute("insert into auth.users(id, email) values (%s, %s)", (uid, email))
    users[key] = (uid, email)

def as_user(key):
    if key is None:
        conn.execute("reset role"); conn.execute("select set_config('request.jwt.claims', '', false)")
        return
    uid, email = users[key]
    conn.execute("reset role")
    conn.execute("select set_config('request.jwt.claims', %s, false)", (json.dumps({"sub": uid, "email": email, "role": "authenticated"}),))
    conn.execute("set role authenticated")

def q(sql, args=()):
    return conn.execute(sql, args).fetchall()

def fails(sql, args=()):
    try:
        conn.execute("savepoint s")
        conn.execute(sql, args)
        conn.execute("release savepoint s")
        return False
    except psycopg.Error:
        conn.execute("rollback to savepoint s")
        return True

conn.autocommit = False

# profiles were created by the sign-up trigger
as_user(None)
check("profiles created on sign-up", q("select count(*) from public.profiles")[0][0] == 5)

# --- families
as_user("pa"); fa = q("select public.ensure_family('Amina family','Amina')")[0][0]
check("ensure_family is idempotent", q("select public.ensure_family()")[0][0] == fa)
as_user("pb"); fb = q("select public.ensure_family('Ben family','Ben')")[0][0]
check("two different families", fa != fb)

# --- children + progress
as_user("pa")
q("insert into public.children(id, family_id, profile) values ('kA1', %s, %s) returning id", (fa, json.dumps({"name": "Aisha"})))
check("display name follows profile", q("select display_name from public.children where id='kA1'")[0][0] == "Aisha")
from datetime import date, timedelta
today = date.today().isoformat(); yday = (date.today() - timedelta(days=1)).isoformat()
q("insert into public.progress(child_id, family_id, data) values ('kA1', %s, %s) returning child_id",
  (fb, json.dumps({"pts": 3, "mins": {today: 300, yday: 120, "junk": 5}})))
check("progress family comes from the child, not the client", q("select family_id from public.progress where child_id='kA1'")[0][0] == fa)
check("daily activity mirrored from mins", sorted(r[0] for r in q("select seconds from public.daily_activity where child_id='kA1'")) == [120, 300])
q("insert into public.children(id, family_id, profile) values ('kA2', %s, '{}'), ('kA3', %s, '{}') returning id", (fa, fa))
check("4th child refused", fails("insert into public.children(id, family_id) values ('kA4', %s)", (fa,)))

as_user("pb")
check("other parent cannot see my children", q("select count(*) from public.children where family_id=%s", (fa,))[0][0] == 0)
check("other parent cannot see my progress", q("select count(*) from public.progress where child_id='kA1'")[0][0] == 0)
check("other parent cannot add a child to my family", fails("insert into public.children(id, family_id) values ('kX1', %s)", (fa,)))
check("other parent cannot write my progress", fails("insert into public.progress(child_id, family_id, data) values ('kA2', %s, '{}')", (fb,)))
check("other parent cannot see my family row", q("select count(*) from public.families where id=%s", (fa,))[0][0] == 0)

# --- billing fields are not writable by parents
as_user("pa")
check("parent cannot give themselves a paid plan", fails("update public.families set plan='family', plan_status='active' where id=%s", (fa,)))
q("update public.families set report_email='amina+r@example.com', report_auto=true where id=%s returning id", (fa,))
check("parent can edit report settings", q("select report_auto from public.families where id=%s", (fa,))[0][0] is True)

# --- trial
r = q("select public.start_trial(%s)", (fa,))[0][0]
check("trial starts", r["ok"] is True)
check("trial only once", q("select public.start_trial(%s)", (fa,))[0][0]["reason"] == "trial_used")
check("trial gives family plan", q("select public.effective_plan(f) from public.families f where id=%s", (fa,))[0][0] == "family")
as_user("pb")
check("someone else cannot start my trial", fails("select public.start_trial(%s)", (fa,)))

# --- invites
as_user("pa")
t_tok = q("insert into public.invites(family_id, email, name, role) values (%s, 'Teacher@School.my', 'Ms Lim', 'teacher') returning token", (fa,))[0][0]
r_tok = q("insert into public.invites(family_id, email, name, role) values (%s, 'therapist@clinic.my', 'Dr Raj', 'therapist') returning token", (fa,))[0][0]
check("invited_by defaults to the caller", q("select invited_by from public.invites where token=%s", (t_tok,))[0][0] == uuid.UUID(users["pa"][0]))
as_user("pb")
check("other parent cannot invite into my family", fails("insert into public.invites(family_id, email, role) values (%s, 'x@y.com', 'teacher')", (fa,)))
check("other parent cannot read my invites", q("select count(*) from public.invites")[0][0] == 0)
as_user("s")
check("stranger cannot use someone else's invite", q("select public.accept_invite(%s)", (t_tok,))[0][0]["reason"] == "wrong_email")
check("stranger sees no children", q("select count(*) from public.children")[0][0] == 0)
as_user("t")
check("teacher accepts (email match is case-insensitive)", q("select public.accept_invite(%s, 'Ms Lim')", (t_tok,))[0][0]["ok"] is True)
check("invite cannot be reused", q("select public.accept_invite(%s)", (t_tok,))[0][0]["reason"] == "already_used")
as_user("r")
check("therapist accepts", q("select public.accept_invite(%s)", (r_tok,))[0][0]["ok"] is True)

# --- teacher access
as_user("t")
check("teacher sees the family's children", q("select count(*) from public.children where family_id=%s", (fa,))[0][0] == 3)
check("teacher sees progress", q("select count(*) from public.progress where child_id='kA1'")[0][0] == 1)
upd = conn.execute("update public.progress set data='{}' where child_id='kA1'").rowcount
check("teacher cannot change progress", upd == 0)
check("teacher cannot edit a child", conn.execute("update public.children set profile='{}' where id='kA1'").rowcount == 0)
check("teacher cannot see invites", q("select count(*) from public.invites")[0][0] == 0)
check("teacher cannot touch billing", fails("update public.families set plan='school' where id=%s", (fa,)))
q("insert into public.shared_notes(child_id, family_id, body, updated_by) values ('kA1', %s, 'Loves trains', %s) returning child_id", (fb, users["t"][0]))
check("teacher writes shared notes", q("select body from public.shared_notes where child_id='kA1'")[0][0] == "Loves trains")
check("teacher cannot book check-ups", fails("insert into public.appointments(child_id, family_id, starts_at, therapist_name) values ('kA1', %s, now()+interval '1 day', 'Dr Raj')", (fa,)))
ctx = q("select public.my_context()")[0][0]
check("my_context shows teacher role", ctx["memberships"][0]["role"] == "teacher" and ctx["memberships"][0]["family_id"] == str(fa))
check("teacher cannot remove members", fails("select public.remove_member(%s, %s)", (fa, users["r"][0])))

# --- therapist
as_user("r")
q("update public.family_members set availability=array['Mon 09:00','Tue 10:00'], display_name='Dr Raj' where family_id=%s and user_id=%s returning user_id", (fa, users["r"][0]))
check("therapist sets own availability", q("select availability from public.family_members where user_id=%s", (users["r"][0],))[0][0] == ["Mon 09:00", "Tue 10:00"])
check("therapist cannot promote self to parent", fails("update public.family_members set role='parent' where user_id=%s", (users["r"][0],)))
check("therapist cannot edit someone else's availability", conn.execute("update public.family_members set availability='{}' where user_id=%s", (users["pa"][0],)).rowcount == 0)
as_user("pa")
av = q("select availability from public.family_members where user_id=%s", (users["pa"][0],))[0][0]
check("parent row untouched by therapist", av == [])

# --- appointments
as_user("pa")
appt = q("insert into public.appointments(child_id, family_id, starts_at, therapist_user_id, therapist_name, booked_by_name) values ('kA1', %s, now()+interval '2 days', %s, 'Dr Raj', 'Amina') returning id, booked_by, family_id",
         (fb, users["r"][0]))[0]
check("booking records the booker", str(appt[1]) == users["pa"][0])
check("booking family comes from the child", appt[2] == fa)
check("no double booking", fails("insert into public.appointments(child_id, family_id, starts_at, therapist_user_id, therapist_name) select child_id, family_id, starts_at, therapist_user_id, therapist_name from public.appointments where id=%s", (appt[0],)))
check("cannot book in the past", fails("insert into public.appointments(child_id, family_id, starts_at, therapist_name) values ('kA1', %s, now()-interval '1 day', 'Someone')", (fa,)))
check("cannot book a non-member therapist", fails("insert into public.appointments(child_id, family_id, starts_at, therapist_user_id, therapist_name) values ('kA1', %s, now()+interval '3 days', %s, 'Fake')", (fa, users["s"][0])))
check("cannot move a booking", fails("update public.appointments set starts_at=now()+interval '5 days' where id=%s", (appt[0],)))
as_user("t")
check("teacher cannot cancel", conn.execute("update public.appointments set status='canceled' where id=%s", (appt[0],)).rowcount == 0)
as_user("r")
check("therapist can cancel own check-up", conn.execute("update public.appointments set status='canceled' where id=%s", (appt[0],)).rowcount == 1)

# --- hall of fame
as_user("pa")
q("insert into public.leaderboard(id, family_id, child_id, name, pts) values ('lbA', %s, 'kA1', 'Aisha', 10) returning id", (fa,))
as_user("pb")
check("others can read hall of fame", q("select count(*) from public.leaderboard where id='lbA'")[0][0] == 1)
check("others cannot change my entry", conn.execute("update public.leaderboard set pts=9999 where id='lbA'").rowcount == 0)
check("cannot post an entry for another family", fails("insert into public.leaderboard(id, family_id, name) values ('lbX', %s, 'X')", (fa,)))

# --- service tables are closed
for t in ["ai_usage", "stripe_events", "email_log"]:
    check(f"{t} is private", fails(f"select * from public.{t}"))

# --- removing someone
as_user("pa")
q("select public.remove_member(%s, %s)", (fa, users["t"][0]))
check("owner cannot be removed", fails("select public.remove_member(%s, %s)", (fa, users["pa"][0])))
as_user("t")
check("removed teacher loses access", q("select count(*) from public.children")[0][0] == 0)

# --- anonymous visitors see nothing
conn.execute("reset role"); conn.execute("select set_config('request.jwt.claims', '', false)"); conn.execute("set role anon")
for t in ["families", "children", "progress", "leaderboard", "profiles"]:
    check(f"anon cannot read {t}", fails(f"select * from public.{t}"))

conn.execute("reset role")
print(f"{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
