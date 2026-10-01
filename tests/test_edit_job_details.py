"""Posting edits preserve the tracked job/application and validate partial pay edits."""
import json

import httpx
import pytest
import pytest_asyncio
from fastapi import FastAPI

from backend import database as db
from backend.routers.jobs import router


@pytest_asyncio.fixture
async def editing_client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "jobs.db")
    await db.init_db()
    job_id = await db.upsert_job({
        "source": "manual", "external_id": "original-link", "title": "Wrong title",
        "company": "Wrong company", "url": "https://example.com/old",
        "salary_min": 100000, "salary_max": 150000,
    })
    await db.update_job_status(job_id, "shortlisted")
    app_id = await db.create_application(job_id, "Saved resume", "Saved letter")
    app = FastAPI()
    app.include_router(router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client, job_id, app_id


@pytest.mark.asyncio
async def test_edit_posting_keeps_identity_pipeline_and_documents(editing_client):
    client, job_id, app_id = editing_client
    edits = {
        "title": "  Senior Engineer  ", "company": "Acme", "location": "New York",
        "url": "https://example.com/correct", "description": "Corrected description",
        "salary_min": 55.5, "salary_max": 85, "salary_period": "hourly",
        "tags": ["Python", "Backend"], "date_posted": "2026-09-30",
        "is_remote": True, "is_easy_apply": False, "apply_type": "external",
    }
    response = await client.patch(f"/api/jobs/{job_id}", json=edits)
    assert response.status_code == 200
    job = response.json()
    for key, value in edits.items():
        if key == "tags":
            assert json.loads(job[key]) == value
        elif key == "title":
            assert job[key] == value.strip()
        else:
            assert job[key] == value
    assert job["id"] == job_id
    assert job["source"] == "manual"
    assert job["external_id"] == "original-link"
    assert job["status"] == "review"
    assert job["application"]["id"] == app_id
    assert job["application"]["resume_content"] == "Saved resume"
    pending = await db.get_pending_reviews()
    assert pending[0]["title"] == "Senior Engineer"
    assert pending[0]["company"] == "Acme"
    assert pending[0]["url"] == edits["url"]


@pytest.mark.asyncio
async def test_partial_update_and_explicit_clearing(editing_client):
    client, job_id, _ = editing_client
    response = await client.patch(f"/api/jobs/{job_id}", json={"company": "Corrected"})
    assert response.status_code == 200
    assert response.json()["title"] == "Wrong title"
    response = await client.patch(f"/api/jobs/{job_id}", json={"salary_min": None, "salary_max": None, "url": "", "tags": []})
    assert response.status_code == 200
    assert response.json()["salary_min"] is None
    assert response.json()["salary_max"] is None
    assert response.json()["url"] == ""
    assert json.loads(response.json()["tags"]) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("edits", [
    {}, {"title": "   "}, {"title": None}, {"salary_min": -1},
    {"salary_min": 160000}, {"salary_max": 90000},
    {"url": "javascript:alert(1)"}, {"url": "https://"},
    {"url": "https://user:password@example.com"}, {"url": "https://example.com:invalid"},
    {"url": "https://bad host.example.com"}, {"salary_period": "monthly"},
    {"status": "applied"}, {"source": "linkedin"}, {"external_id": "changed"},
    {"tags": None}, {"is_remote": None}, {"date_posted": "not-a-date"},
])
async def test_invalid_edits_leave_job_unchanged(editing_client, edits):
    client, job_id, _ = editing_client
    before = await db.get_job(job_id)
    response = await client.patch(f"/api/jobs/{job_id}", json=edits)
    assert response.status_code == 422
    assert await db.get_job(job_id) == before


@pytest.mark.asyncio
async def test_missing_job(editing_client):
    client, _, _ = editing_client
    response = await client.patch("/api/jobs/missing", json={"title": "Engineer"})
    assert response.status_code == 404
