"""MockDmsAdapter: deterministic, big enough, obviously fictional, with edge cases."""

from __future__ import annotations

import re
from datetime import datetime

import pytest

from dms_analytics.adapters.base import AccessLostError, NotSignedInError
from dms_analytics.adapters.mock import ODD_TITLES, MockDmsAdapter
from tests.conftest import NOW


@pytest.fixture(scope="module")
def firm() -> MockDmsAdapter:
    return MockDmsAdapter(seed=42, now=NOW)


async def all_workspaces(ad: MockDmsAdapter, since: datetime | None = None) -> list:  # type: ignore[type-arg]
    out = []
    async for page in ad.iter_workspaces("MOCK", since):
        assert 0 < len(page) <= 100
        out.extend(page)
    return out


def test_size_and_shape(firm: MockDmsAdapter) -> None:
    assert len(firm.workspaces) == 400
    docs = sum(len(w.docs) for w in firm.workspaces)
    assert 30_000 <= docs <= 60_000
    assert len(firm.partners) == 8 and len(firm.fee_earners) == 25
    areas = {w.raw.profile["custom3"] for w in firm.workspaces}
    offices = {w.raw.profile["custom5"] for w in firm.workspaces}
    assert len(areas) == 6 and len(offices) == 2
    opened = sorted(w.raw.created_at for w in firm.workspaces)
    assert opened[0].year == 2019 and (NOW - opened[-1]).days < 10


def test_deterministic_for_seed() -> None:
    a, b = MockDmsAdapter(seed=42, now=NOW, n_workspaces=50), MockDmsAdapter(
        seed=42, now=NOW, n_workspaces=50)
    assert [w.raw for w in a.workspaces] == [w.raw for w in b.workspaces]
    assert [w.docs for w in a.workspaces] == [w.docs for w in b.workspaces]
    c = MockDmsAdapter(seed=7, now=NOW, n_workspaces=50)
    assert [w.raw for w in a.workspaces] != [w.raw for w in c.workspaces]


def test_names_are_obviously_fictional(firm: MockDmsAdapter) -> None:
    for p in firm.partners:
        assert re.fullmatch(r"Partner [A-Z][a-z]+", p.name)
    for p in firm.fee_earners:
        assert re.fullmatch(r"Fee Earner [A-Za-z\-]+", p.name)
    for w in firm.workspaces:
        assert w.raw.profile["custom1_description"].endswith("(fictional)")
        assert "(fictional" in w.raw.profile["custom2_description"]
        for d in w.docs:
            assert "(fictional" in d.name


def test_edge_cases_present(firm: MockDmsAdapter) -> None:
    names = {w.raw.profile["custom2_description"] for w in firm.workspaces} | {
        d.name for w in firm.workspaces for d in w.docs}
    assert any("<script>" in n for n in names)
    assert len(names & set(ODD_TITLES)) >= 5
    assert sum(w.restricted for w in firm.workspaces) == 10
    assert sum(len(w.deleted_doc_ids) for w in firm.workspaces) > 50
    assert any(not w.active for w in firm.workspaces)  # dormant
    assert any(w.raw.profile["custom6"] == "INTERNAL" for w in firm.workspaces)
    soon = [w for w in firm.workspaces if w.raw.profile["custom21"]
            and 0 <= (datetime.fromisoformat(w.raw.profile["custom21"]) - NOW).days <= 90]
    assert len(soon) >= 20


async def test_restricted_workspaces_disappear_on_second_listing() -> None:
    ad = MockDmsAdapter(now=NOW, n_workspaces=100)
    first = {w.id for w in await all_workspaces(ad)}
    second = {w.id for w in await all_workspaces(ad)}
    restricted = {w.raw.id for w in ad.workspaces if w.restricted}
    assert restricted and restricted <= first
    assert first - second == restricted
    with pytest.raises(AccessLostError):
        async for _ in ad.iter_documents("MOCK", next(iter(restricted)), None):
            pass


async def test_deleted_documents_disappear_after_first_listing() -> None:
    ad = MockDmsAdapter(now=NOW, n_workspaces=100)
    ws = next(w for w in ad.workspaces if w.deleted_doc_ids and not w.restricted)

    async def ids() -> set[str]:
        out: set[str] = set()
        async for page in ad.iter_documents("MOCK", ws.raw.id, None):
            out |= {d.id for d in page}
        return out
    first, second = await ids(), await ids()
    assert first - second == ws.deleted_doc_ids


async def test_since_filter_and_new_documents() -> None:
    ad = MockDmsAdapter(now=NOW, n_workspaces=60)
    await all_workspaces(ad)
    await all_workspaces(ad)  # generation 1 adds new documents
    assert ad.generation == 1
    new_total = 0
    for w in ad.workspaces:
        if w.restricted:
            continue
        async for page in ad.iter_documents("MOCK", w.raw.id, NOW.replace(hour=11)):
            assert all(d.edited_at >= NOW.replace(hour=11) for d in page)
            new_total += len(page)
    assert new_total >= 15


async def test_sign_out_blocks_calls() -> None:
    ad = MockDmsAdapter(now=NOW, n_workspaces=5)
    await ad.sign_out()
    with pytest.raises(NotSignedInError):
        await ad.list_libraries()
    assert await ad.current_user() is None
    assert (await ad.sign_in()).status == "signed_in"
    assert (await ad.current_user()) is not None


async def test_folders_and_versions() -> None:
    ad = MockDmsAdapter(now=NOW, n_workspaces=5)
    w = ad.workspaces[-1]
    async for folders in ad.iter_folders("MOCK", w.raw.id):
        assert {f.path for f in folders} == {d.folder_path for d in w.docs}
    d = w.docs[0]
    versions = await ad.get_versions("MOCK", d.id)
    assert [v.version for v in versions] == list(range(1, d.version + 1))
