"""Hiring stages filter submitted applications without changing submission status."""
import httpx
import pytest
from fastapi import FastAPI

from backend import database as db
from backend.routers.applications import router


@pytest.mark.asyncio
async def test_hiring_stages_are_disjoint_and_filter_before_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "jobs.db")
    await db.init_db()
    ids = {}
    for outcome in sorted(db.VALID_OUTCOMES):
        job_id = await db.upsert_job({"source": "test", "external_id": outcome, "title": outcome})
        app_id = await db.create_application(job_id, "Saved resume", "Saved letter")
        await db.update_application_status(app_id, "applied")
        await db.update_application_outcome(app_id, outcome)
        ids[outcome] = app_id
    app = FastAPI()
    app.include_router(router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        seen = set()
        for stage, outcomes in db.POST_APPLY_STAGES.items():
            response = await client.get("/api/applications/submitted", params={"stage": stage})
            assert response.status_code == 200
            rows = response.json()
            stage_ids = {row["id"] for row in rows}
            assert stage_ids == {ids[outcome] for outcome in outcomes}
            assert not seen & stage_ids
            seen |= stage_ids
            limited = await client.get("/api/applications/submitted", params={"stage": stage, "limit": 1})
            assert len(limited.json()) == 1
            assert limited.json()[0]["outcome"] in outcomes
        assert seen == set(ids.values())
        # Existing iOS/analytics clients can still request all submitted history.
        assert len((await client.get("/api/applications/submitted")).json()) == 7
        assert (await client.get("/api/applications/submitted?stage=invalid")).status_code == 422


@pytest.mark.asyncio
async def test_hiring_progress_preserves_identity_documents_and_history(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "jobs.db")
    await db.init_db()
    job_id = await db.upsert_job({"source": "manual", "external_id": "same-job", "title": "Engineer"})
    app_id = await db.create_application(job_id, "Saved resume", "Saved letter")
    await db.update_application_status(app_id, "applied")
    original = (await db.get_job(job_id))["application"]
    app = FastAPI()
    app.include_router(router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        for outcome, stage in [("interview", "interviewing"), ("offer", "offer"), ("awaiting", "applied"),
                               ("rejected", "closed"), ("awaiting", "applied")]:
            response = await client.patch(f"/api/applications/{app_id}/outcome", json={"outcome": outcome})
            assert response.status_code == 200
            rows = await db.get_submitted_applications(stage=stage)
            assert [row["id"] for row in rows] == [app_id]
            assert rows[0]["status"] == "applied"
            assert rows[0]["applied_at"] == original["applied_at"]
            assert rows[0]["resume_content"] == "Saved resume"
        listed = (await db.get_jobs())["jobs"]
        assert next(job for job in listed if job["id"] == job_id)["app_outcome"] == "awaiting"
        history = await db.get_application_events(app_id)
        assert [event["to_outcome"] for event in history][-5:] == ["interview", "offer", "awaiting", "rejected", "awaiting"]
        # Soft-deleted postings remain hidden from every hiring stage.
        await db.update_job_status(job_id, "deleted")
        assert await db.get_submitted_applications(stage="applied") == []


@pytest.mark.asyncio
async def test_legacy_missing_outcome_and_unsent_application(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "jobs.db")
    await db.init_db()
    job_id = await db.upsert_job({"source": "test", "external_id": "legacy", "title": "Engineer"})
    app_id = await db.create_application(job_id, "Resume", "Letter")
    assert await db.get_submitted_applications(stage="applied") == []
    await db.update_application_status(app_id, "applied")
    conn = await db._get_db()
    try:
        await conn.execute("UPDATE applications SET outcome = NULL WHERE id = ?", (app_id,))
        await conn.commit()
    finally:
        await conn.close()
    assert [row["id"] for row in await db.get_submitted_applications(stage="applied")] == [app_id]
