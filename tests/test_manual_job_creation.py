"""Linkless recruiter roles retain their facts, pipeline state, and sync identity."""
import json
import sqlite3

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from backend import database as db
from backend.routers.jobs import router
from backend.sync.entities import JobAdapter, TriageAdapter, ApplicationAdapter


@pytest_asyncio.fixture
async def manual_client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "jobs.db")
    await db.init_db()
    app = FastAPI()
    app.include_router(router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client


@pytest.mark.asyncio
async def test_recruiter_message_without_url_is_in_inbox(manual_client):
    details = {
        "title": "  Senior Software Engineer  ", "company": "Mastercard",
        "location": "Arlington, VA (hybrid, 3 days onsite)",
        "description": "Lainey Smith at Experis shared a role via LinkedIn.\nCI/CD, platform engineering, IaC.",
        "tags": ["LinkedIn message", "DevOps"],
    }
    response = await manual_client.post("/api/jobs", json=details)
    assert response.status_code == 201
    job = response.json()
    assert job["title"] == details["title"].strip()
    assert job["company"] == details["company"]
    assert job["location"] == details["location"]
    assert job["description"] == details["description"]
    assert json.loads(job["tags"]) == details["tags"]
    assert job["url"] == ""
    assert job["source"] == "manual"
    assert job["external_id"]
    assert job["application"] is None
    inbox = await manual_client.get("/api/jobs", params={"status": "discovered"})
    assert [entry["id"] for entry in inbox.json()["jobs"]] == [job["id"]]
    # A posting link can be added later without replacing the recruiter entry.
    edited = await manual_client.patch(f"/api/jobs/{job['id']}", json={"url": "https://example.com/role"})
    assert edited.json()["external_id"] == job["external_id"]


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["discovered", "shortlisted", "manual"])
async def test_initial_pipeline_state_and_sync(manual_client, status):
    response = await manual_client.post("/api/jobs", json={"title": "Engineer", "status": status})
    assert response.status_code == 201
    job = response.json()
    assert job["status"] == status
    if status == "manual":
        app = job["application"]
        assert app["status"] == "applied"
        assert app["applied_at"]
        assert app["resume_content"] == app["cover_letter_content"] == ""
        assert app["honesty_level"] == "honest"
        assert [row["job_id"] for row in await db.get_submitted_applications()] == [job["id"]]
    else:
        assert job["application"] is None
        if status == "shortlisted":
            assert [row["id"] for row in (await db.get_jobs(status="shortlisted"))["jobs"]] == [job["id"]]
    conn = await db._get_db()
    try:
        sync_id = JobAdapter.sync_id(job["source"], job["external_id"])
        facts = await JobAdapter().snapshot(conn)
        triage = await TriageAdapter().snapshot(conn)
        assert facts[sync_id]["title"] == "Engineer"
        assert not facts[sync_id]["url"]
        for field in ("company", "location", "url", "description", "date_posted"):
            assert facts[sync_id][field] == ""  # iOS requires non-null text.
        assert triage[sync_id]["status"] == status
        if status == "manual":
            apps = await ApplicationAdapter().snapshot(conn)
            assert apps[job["application"]["id"]]["job_ref"] == sync_id
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_similar_linkless_entries_have_distinct_identities(manual_client):
    details = {"title": "Engineer", "company": "Acme", "url": ""}
    first = (await manual_client.post("/api/jobs", json=details)).json()
    second = (await manual_client.post("/api/jobs", json=details)).json()
    assert first["id"] != second["id"]
    assert first["external_id"] != second["external_id"]


@pytest.mark.asyncio
@pytest.mark.parametrize("details", [
    {}, {"title": "   "}, {"title": None}, {"title": "x" * 501},
    {"title": "Engineer", "status": "interview"},
    {"title": "Engineer", "url": "javascript:alert(1)"},
    {"title": "Engineer", "url": "https://user:pass@example.com"},
    {"title": "Engineer", "salary_min": -1},
    {"title": "Engineer", "salary_min": 200, "salary_max": 100},
    {"title": "Engineer", "source": "linkedin"},
    {"title": "Engineer", "external_id": "spoofed"},
    {"title": "Engineer", "company": None},
    {"title": "Engineer", "url": None},
])
async def test_invalid_creation_does_not_leave_partial_entries(manual_client, details):
    response = await manual_client.post("/api/jobs", json=details)
    assert response.status_code == 422
    assert (await manual_client.get("/api/jobs")).json()["total"] == 0
    assert await db.get_submitted_applications() == []


@pytest.mark.asyncio
async def test_applied_creation_rolls_back_job_if_application_insert_fails(manual_client):
    conn = await db._get_db()
    try:
        await conn.execute("""CREATE TRIGGER reject_application BEFORE INSERT ON applications
                           BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END""")
        await conn.commit()
    finally:
        await conn.close()
    with pytest.raises(sqlite3.IntegrityError, match="simulated insert failure"):
        await db.create_manual_job({"title": "Engineer"}, "manual")
    assert (await manual_client.get("/api/jobs")).json()["total"] == 0
