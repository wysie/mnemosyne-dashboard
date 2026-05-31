import importlib.metadata as md
import sqlite3
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from config import default_db_path, effective_config, load_config, public_config, save_config
from dashboard_core import DashboardStore
from server import Handler


def make_db(path: Path):
    con = sqlite3.connect(path)
    con.executescript("""
    CREATE TABLE working_memory (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT, timestamp TEXT,
        session_id TEXT DEFAULT 'default', importance REAL DEFAULT 0.5,
        metadata_json TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        recall_count INTEGER DEFAULT 0, last_recalled TIMESTAMP DEFAULT NULL,
        valid_until TIMESTAMP DEFAULT NULL, superseded_by TEXT DEFAULT NULL,
        scope TEXT DEFAULT 'global', author_id TEXT, author_type TEXT, channel_id TEXT,
        veracity TEXT DEFAULT 'unknown'
    );
    CREATE TABLE episodic_memory (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL, content TEXT NOT NULL, source TEXT, timestamp TEXT,
        session_id TEXT DEFAULT 'default', importance REAL DEFAULT 0.5,
        metadata_json TEXT, summary_of TEXT DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        recall_count INTEGER DEFAULT 0, last_recalled TIMESTAMP DEFAULT NULL,
        valid_until TIMESTAMP DEFAULT NULL, superseded_by TEXT DEFAULT NULL,
        scope TEXT DEFAULT 'global', author_id TEXT, author_type TEXT, channel_id TEXT,
        veracity TEXT DEFAULT 'unknown', tier INTEGER DEFAULT 1, degraded_at TEXT
    );
    CREATE TABLE triples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
        valid_from TEXT NOT NULL, valid_until TEXT, source TEXT, confidence REAL DEFAULT 1.0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE consolidation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, items_consolidated INTEGER,
        summary_preview TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)
    con.execute("INSERT INTO working_memory(id,content,source,timestamp,session_id,importance,scope) VALUES (?,?,?,?,?,?,?)",
                ('w1','YC prefers local-only WhatsApp memory','preference','2026-01-01T00:00:00','s1',0.9,'global'))
    con.execute("INSERT INTO episodic_memory(id,content,source,timestamp,session_id,importance,scope,summary_of) VALUES (?,?,?,?,?,?,?,?)",
                ('e1','Built a Mnemosyne dashboard visualiser','task','2026-01-02T00:00:00','s2',0.6,'session','w1'))
    con.execute("INSERT INTO working_memory(id,content,source,timestamp,session_id,importance,scope) VALUES (?,?,?,?,?,?,?)",
                ('w2','YC uses Obsidian for notes','preference','2026-01-03T00:00:00','s3',0.4,'global'))
    con.execute("INSERT INTO working_memory(id,content,source,timestamp,session_id,importance,scope) VALUES (?,?,?,?,?,?,?)",
                ('w3','YC knows Diana from school','preference','2026-01-04T00:00:00','s4',0.4,'global'))
    con.execute("INSERT INTO working_memory(id,content,source,timestamp,session_id,importance,scope,last_recalled) VALUES (?,?,?,?,?,?,?,?)",
                ('w4','YC uses WHOOP for health and recovery','health','2026-05-04T08:00:00','s5',0.7,'global','2026-05-04T09:00:00'))
    con.execute("INSERT INTO episodic_memory(id,content,source,timestamp,session_id,importance,scope,summary_of) VALUES (?,?,?,?,?,?,?,?)",
                ('e2','Shipped Mnemosyne Dashboard v0.7 planning','task','2026-05-04T10:00:00','s5',0.5,'session','w4'))
    con.execute("INSERT INTO triples(subject,predicate,object,valid_from,source,confidence) VALUES (?,?,?,?,?,?)",
                ('YC','prefers','local-only memory','2026-01-01','preference',0.95))
    con.execute("INSERT INTO triples(subject,predicate,object,valid_from,source,confidence) VALUES (?,?,?,?,?,?)",
                ('YC','uses','Obsidian','2026-01-01','preference',0.95))
    con.execute("INSERT INTO triples(subject,predicate,object,valid_from,source,confidence) VALUES (?,?,?,?,?,?)",
                ('YC','knows','Diana','2026-01-01','preference',0.95))
    con.execute("INSERT INTO consolidation_log(session_id,items_consolidated,summary_preview) VALUES (?,?,?)",
                ('s2',3,'Dashboard work'))
    con.execute("UPDATE working_memory SET veracity = 'stated' WHERE id = 'w1'")
    con.execute("UPDATE working_memory SET veracity = 'tool' WHERE id = 'w4'")
    con.execute("UPDATE episodic_memory SET veracity = 'inferred', tier = 2, degraded_at = '2026-05-05T00:00:00' WHERE id = 'e1'")
    con.execute("UPDATE episodic_memory SET veracity = 'imported', tier = 3, degraded_at = '2026-05-05T01:00:00' WHERE id = 'e2'")
    con.commit()
    con.close()


def test_release_version_is_consistent():
    pyproject = tomllib.loads((ROOT / 'pyproject.toml').read_text())
    project_version = pyproject['project']['version']
    plugin_text = (ROOT / 'plugin.yaml').read_text()

    assert project_version == '0.13.1'
    assert f'version: "{project_version}"' in plugin_text
    assert Handler.server_version == f'MnemosyneDashboard/{project_version}'


def test_stats_counts_memory_tables(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    stats = DashboardStore(db).stats()
    assert stats['counts']['working_memory'] == 4
    assert stats['counts']['episodic_memory'] == 2
    assert stats['counts']['triples'] == 3
    assert stats['counts']['consolidation_log'] == 1


def test_stats_exposes_v23_trust_and_degradation_mix(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    stats = DashboardStore(db).stats()

    assert {r['veracity']: r['count'] for r in stats['by_veracity']} == {
        'unknown': 2,
        'stated': 1,
        'tool': 1,
        'inferred': 1,
        'imported': 1,
    }
    assert {r['degradation_label']: r['count'] for r in stats['by_degradation']} == {
        'hot': 0,
        'warm': 1,
        'cold': 1,
    }
    assert stats['contamination']['total'] == 5
    assert stats['contamination']['high_importance'] == 2
    assert stats['degradation']['degraded'] == 2


def test_list_memories_searches_both_tiers(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    rows = DashboardStore(db).list_memories(kind='all', q='visualiser', limit=10)
    assert [r['id'] for r in rows] == ['e1']
    assert rows[0]['tier'] == 'episodic'
    assert rows[0]['memory_kind'] == 'episodic'
    assert rows[0]['degradation_tier'] == 2
    assert rows[0]['degradation_label'] == 'warm'
    assert rows[0]['veracity'] == 'inferred'
    assert rows[0]['trust_weight'] == 0.7
    assert rows[0]['degradation_weight'] == 0.5
    assert rows[0]['effective_memory_weight'] == 0.35


def test_list_memories_filters_v23_veracity_and_degradation(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    store = DashboardStore(db)

    assert [r['id'] for r in store.list_memories(kind='all', veracity='tool', limit=10)] == ['w4']
    assert [r['id'] for r in store.list_memories(kind='all', contaminated_only=True, sort='importance', limit=10)] == ['w4', 'e1', 'e2', 'w3', 'w2']
    assert [r['id'] for r in store.list_memories(kind='episodic', degradation_tier=3, limit=10)] == ['e2']
    assert [r['id'] for r in store.list_memories(kind='episodic', degraded_only=True, limit=10)] == ['e2', 'e1']


def test_review_queues_surface_trust_lifecycle_work(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    con = sqlite3.connect(db)
    con.execute(
        "INSERT INTO working_memory(id,content,source,timestamp,session_id,importance,scope,veracity,valid_until) VALUES (?,?,?,?,?,?,?,?,?)",
        ('expired_review', 'Expired contaminated review item', 'test', '2026-01-05T00:00:00', 's6', 0.99, 'global', 'unknown', '2020-01-01T00:00:00'),
    )
    con.execute(
        "INSERT INTO working_memory(id,content,source,timestamp,session_id,importance,scope,veracity,superseded_by) VALUES (?,?,?,?,?,?,?,?,?)",
        ('superseded_review', 'Superseded contaminated review item', 'test', '2026-01-06T00:00:00', 's7', 0.98, 'global', 'unknown', 'replacement'),
    )
    con.commit()
    con.close()
    store = DashboardStore(db)

    review = store.review_queues(queue='high_importance_contaminated', limit=10)
    assert review['read_only'] is True
    assert [card['key'] for card in review['cards']] == ['contaminated', 'high_importance_contaminated', 'degraded', 'due_for_degradation']
    assert review['counts']['contaminated'] == 5
    assert review['counts']['high_importance_contaminated'] == 2
    assert review['counts']['degraded'] == 2
    assert 'due_for_degradation' in review['counts']
    assert [item['id'] for item in review['queues']['high_importance_contaminated']['items']] == ['w4', 'e1']
    assert all(item['status'] == 'active' for item in review['queues']['high_importance_contaminated']['items'])
    assert review['queues']['degraded']['items'] == []
    assert review['queues']['contaminated']['title'] == 'Needs review'
    assert review['queues']['high_importance_contaminated']['title'] == 'Important memories needing review'
    assert review['queues']['degraded']['title'] == 'Degraded'
    assert review['queues']['contaminated']['filter']['contaminated_only'] == '1'
    assert review['queues']['degraded']['filter']['degraded_only'] == '1'
    assert review['queues']['due_for_degradation']['filter']['due_for_degradation'] == '1'


def test_review_queues_page_selected_queue_and_filter_by_importance(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    con = sqlite3.connect(db)
    con.executemany(
        "INSERT INTO working_memory(id,content,source,timestamp,session_id,importance,scope,veracity) VALUES (?,?,?,?,?,?,?,?)",
        [
            (f'bulk{i:03d}', f'Bulk contaminated memory {i}', 'test', '2026-05-06T00:00:00', 'bulk', 0.95 if i < 110 else 0.1, 'global', 'unknown')
            for i in range(150)
        ],
    )
    con.commit()
    con.close()

    review = DashboardStore(db).review_queues(queue='contaminated', limit=100, offset=0, min_importance=0.8)

    assert review['queue'] == 'contaminated'
    assert review['limit'] == 100
    assert review['offset'] == 0
    assert review['next_offset'] == 100
    assert review['has_more'] is True
    assert review['counts']['contaminated'] == 110
    assert len(review['queues']['contaminated']['items']) == 100
    assert review['queues']['high_importance_contaminated']['items'] == []
    assert all(float(item['importance']) >= 0.8 for item in review['queues']['contaminated']['items'])

    next_page = DashboardStore(db).review_queues(queue='contaminated', limit=100, offset=100, min_importance=0.8)
    assert next_page['next_offset'] is None
    assert next_page['has_more'] is False
    assert len(next_page['queues']['contaminated']['items']) == 10


def test_review_queues_filter_by_search_query(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    review = DashboardStore(db).review_queues(queue='contaminated', limit=100, q='WHOOP')

    assert review['counts']['contaminated'] == 1
    assert [item['id'] for item in review['queues']['contaminated']['items']] == ['w4']


def test_lifecycle_dashboard_surfaces_degradation_queues(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    store = DashboardStore(db)

    lifecycle = store.lifecycle_dashboard(limit=10)
    assert lifecycle['read_only'] is True
    assert lifecycle['thresholds']['tier2_days'] == 30
    assert lifecycle['thresholds']['tier3_days'] == 180
    assert [card['key'] for card in lifecycle['cards']] == ['hot', 'warm', 'cold', 'due_for_degradation', 'recently_degraded', 'high_importance_degraded']
    assert lifecycle['counts']['hot'] == 0
    assert lifecycle['counts']['warm'] == 1
    assert lifecycle['counts']['cold'] == 1
    assert lifecycle['counts']['recently_degraded'] == 2
    assert lifecycle['counts']['high_importance_degraded'] == 1
    assert [item['id'] for item in lifecycle['queues']['recently_degraded']['items']] == ['e2', 'e1']
    assert [item['id'] for item in lifecycle['queues']['high_importance_degraded']['items']] == ['e1']
    assert lifecycle['queues']['cold']['filter']['degradation_tier'] == '3'
    assert lifecycle['queues']['due_for_degradation']['filter']['due_for_degradation'] == '1'


def test_search_uses_token_prefix_not_mid_word_substring(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    store = DashboardStore(db)

    memory_rows = store.list_memories(kind='all', q='Dian', limit=10)
    assert [r['id'] for r in memory_rows] == ['w3']

    triple_rows = store.triples(q='Dian', limit=10)
    assert [r['object'] for r in triple_rows] == ['Diana']

    search = store.global_search(q='Dian', limit=10)
    assert [r['id'] for r in search['memories']] == ['w3']
    assert [r['object'] for r in search['triples']] == ['Diana']


def test_list_memories_filters_and_sorts_by_importance(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    rows = DashboardStore(db).list_memories(kind='all', scope='global', session_id='s1', sort='importance', limit=10)
    assert [r['id'] for r in rows] == ['w1']
    assert rows[0]['importance'] == 0.9


def test_graph_returns_nodes_edges_and_filterable_metadata(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    graph = DashboardStore(db).graph(q='local-only', limit=10)
    labels = {n['label'] for n in graph['nodes']}
    assert {'YC', 'local-only memory'} <= labels
    assert graph['edges'][0]['predicate'] == 'prefers'
    assert graph['edges'][0]['subject'] == 'YC'
    assert graph['edges'][0]['object'] == 'local-only memory'


def test_timeline_search_matches_session_id(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    timeline = DashboardStore(db).timeline(q='s2', group='session', limit=20)
    groups = {g['key']: g for g in timeline['groups']}
    assert 's2' in groups
    assert {e['type'] for e in groups['s2']['events']} == {'memory', 'consolidation'}


def test_triple_search_matches_terms_across_subject_predicate_object(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    rows = DashboardStore(db).triples(q='YC knows Diana', limit=10)
    assert [(r['subject'], r['predicate'], r['object']) for r in rows] == [('YC', 'knows', 'Diana')]


def test_diagnostics_reports_database_health(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    diag = DashboardStore(db).diagnostics()
    assert diag['ok'] is True
    assert diag['exists'] is True
    assert diag['read_only'] is True
    assert diag['table_counts']['working_memory'] == 4
    assert diag['table_counts']['triples'] == 3


def test_session_detail_unifies_related_items(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    detail = DashboardStore(db).session_detail('s2')
    assert detail['session_id'] == 's2'
    assert detail['counts']['memories'] == 1
    assert detail['counts']['consolidations'] == 1
    assert {e['type'] for e in detail['events']} == {'memory', 'consolidation'}


def test_memory_status_filter_and_safe_mutations(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'hermes'))
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    store = DashboardStore(db)

    assert [r['id'] for r in store.list_memories(kind='all', status='active', limit=10)] == ['e2', 'w4', 'w3', 'w2', 'e1', 'w1']

    expired = store.invalidate_memory('w2')
    assert expired['ok'] is True
    assert expired['item']['status'] == 'expired'
    assert [r['id'] for r in store.list_memories(kind='all', status='expired', limit=10)] == ['w2']

    updated = store.set_memory_importance('w1', 0.33)
    assert updated['item']['importance'] == 0.33

    trust = store.set_memory_veracity('w2', 'stated')
    assert trust['ok'] is True
    assert trust['item']['veracity'] == 'stated'

    expiry = store.set_memory_expiry('w3', '2026-06-01T00:00:00')
    assert expiry['ok'] is True
    assert expiry['item']['valid_until'] == '2026-06-01T00:00:00'

    superseded = store.supersede_memory('w1', 'YC prefers local-only private memory', importance=0.95)
    assert superseded['item']['status'] == 'superseded'
    assert superseded['replacement']['content'] == 'YC prefers local-only private memory'
    assert superseded['replacement']['status'] == 'active'
    assert superseded['replacement_id'] in {r['id'] for r in store.list_memories(kind='working', status='active', limit=20)}

    audit = store.audit_log()
    assert [row['action'] for row in audit[:5]] == ['supersede', 'expiry', 'veracity', 'importance', 'invalidate']
    assert Path(superseded['backup']['path']).exists()


def test_config_file_env_and_runtime_overrides(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'hermes'))
    monkeypatch.delenv('MNEMOSYNE_DASHBOARD_CONFIG', raising=False)
    cfg = load_config(create=True)
    assert cfg.host == '0.0.0.0'
    assert cfg.port == 8765
    assert cfg.memory_admin_enabled is False
    assert Path(tmp_path / 'hermes' / 'plugin-data' / 'mnemosyne-dashboard' / 'config.json').exists()

    cfg = save_config(port=9876, db_path=str(tmp_path / 'test.db'))
    assert cfg.host == '0.0.0.0'
    assert cfg.port == 9876
    assert cfg.local_url == 'http://127.0.0.1:9876/'

    monkeypatch.setenv('MNEMOSYNE_DASHBOARD_PORT', '9999')
    assert load_config().port == 9999
    assert effective_config({'port': 7777}).port == 7777


def test_default_db_path_detects_existing_mnemosyne_database(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'hermes'))
    db = tmp_path / 'hermes' / 'mnemosyne' / 'data' / 'mnemosyne.db'
    db.parent.mkdir(parents=True)
    db.write_text('sqlite placeholder')
    assert default_db_path() == db
    assert load_config(create=True).db_path == str(db)


def test_memory_intelligence_read_only_views(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    store = DashboardStore(db)

    digest = store.today_digest(day='2026-05-04')
    assert digest['read_only'] is True
    assert digest['counts']['memories_added'] == 2
    assert digest['counts']['memories_recalled'] == 1
    assert digest['counts']['contaminated_added'] == 2
    assert digest['counts']['degraded_added'] == 1
    assert {m['id'] for m in digest['memories_added']} == {'w4', 'e2'}
    by_today_veracity = {r['label']: r['count'] for r in digest['breakdowns']['veracity']}
    assert by_today_veracity['tool'] == 1
    assert by_today_veracity['imported'] == 1
    by_today_degradation = {r['label']: r['count'] for r in digest['breakdowns']['degradation']}
    assert by_today_degradation['cold'] == 1

    profile = store.inferred_profile(limit_per_section=5)
    sections = {s['name']: s for s in profile['sections']}
    assert 'Health / wearables' in sections
    assert any('WHOOP' in item['label'] for item in sections['Health / wearables']['items'])
    assert 'Home setup' in DashboardStore._context_category_names()
    assert profile['summary']['indexed_signals'] >= 1
    assert profile['summary']['sensitive'] >= 1

    constellation = store.constellation(limit=80)
    assert constellation['read_only'] is True
    labels = {n['label'] for n in constellation['nodes']}
    assert 'YC' in labels
    assert constellation['edges']


def test_memory_domain_classifier_keeps_dungeon_sections_meaningful():
    classify = DashboardStore._category_for_text

    assert classify('Hindsight daemon health check is healthy with DB connected') == 'Agent memory'
    assert classify('Mnemosyne Labyrinth FPS viewport joystick fix for Memory Palace') == 'Dashboard / visualisers'
    assert classify('whatsapp-cli sync watchdog restart service com.whatsapp-cli.sync') == 'Messaging / WhatsApp'
    assert classify('YC uses WHOOP sleep recovery HRV and strain reports') == 'Health / wearables'
    assert classify('Hokkaido April trip itinerary with Hakodate sakura') == 'Travel / leisure'
    assert classify('Sheryl and Hope household helper permissions') == 'People'
    assert classify('Home Assistant light sensor automation') == 'Home setup'
    assert classify('Promptlybuilt marketing business LinkedIn case study') == 'Work / business'
    assert classify('WhatsApp history must stay local-only and no cloud') == 'Privacy rules'




def test_realtime_status_detects_mnemosyne_streaming_and_deltasync(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    status = DashboardStore(db).realtime_status()

    assert status['read_only'] is True
    try:
        expected_version = md.version('mnemosyne-memory')
    except md.PackageNotFoundError:
        expected_version = 'unknown'
    assert status['mnemosyne_version'] == expected_version
    if expected_version == 'unknown':
        assert status['streaming_supported'] is False
        assert status['deltasync_supported'] is False
        assert status['live_enabled'] is False
        assert status['event_types'] == []
        assert status['deltasync_tables'] == []
    else:
        assert status['streaming_supported'] is True
        assert status['deltasync_supported'] is True
        assert status['live_enabled'] is True
        assert 'MEMORY_ADDED' in status['event_types']
        assert 'MEMORY_UPDATED' in status['event_types']
        assert status['deltasync_tables'] == ['working_memory', 'episodic_memory']
        assert {'sync_to', 'sync_from', 'compute_delta', 'apply_delta'} <= set(status['deltasync_methods'])
        assert status['realtime_generation'] in {'mnemosyne-2.6', 'mnemosyne-3.x'}
        assert status['stream_api']['deltasync'] is True
    assert status['db_modified_at']
    assert 'posting_credential' not in str(status)


def test_realtime_event_snapshot_includes_private_dashboard_content_but_not_metadata_json(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    events = DashboardStore(db).realtime_event_snapshot(limit=6)

    assert events
    assert all(event['event_type'] == 'MEMORY_SNAPSHOT' for event in events)
    assert all(event['memory_id'] for event in events)
    assert all(event['memory_kind'] in {'working', 'episodic'} for event in events)
    assert all('content' in event for event in events)
    assert 'YC prefers local-only WhatsApp memory' in str(events)
    assert all('metadata_json' not in event for event in events)




def test_realtime_event_delta_detects_cross_process_db_writes(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    store = DashboardStore(db)
    initial = store.realtime_event_snapshot(limit=25)
    seen = {event['memory_id'] for event in initial}

    con = sqlite3.connect(db)
    con.execute("INSERT INTO working_memory(id,content,source,timestamp,session_id,importance,scope,veracity) VALUES (?,?,?,?,?,?,?,?)",
                ('w-live','Realtime DB polling test memory','test','2026-05-12T23:59:59','s-live',0.8,'global','tool'))
    con.commit()
    con.close()

    delta = store.realtime_event_delta(seen_ids=seen, limit=25)

    assert [event['memory_id'] for event in delta] == ['w-live']
    assert delta[0]['event_type'] == 'MEMORY_ADDED'
    assert delta[0]['content'] == 'Realtime DB polling test memory'

def test_realtime_event_delta_detects_updates_recalls_invalidations_and_consolidations(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    store = DashboardStore(db)
    initial = store.realtime_event_snapshot(limit=25)
    seen_state = {event['memory_id']: event['live_signature'] for event in initial}

    con = sqlite3.connect(db)
    con.execute("UPDATE working_memory SET content=?, timestamp=? WHERE id='w1'", ('YC strongly prefers local-only WhatsApp memory', '2026-05-12T23:55:00'))
    con.execute("UPDATE working_memory SET recall_count=recall_count+1, last_recalled=? WHERE id='w2'", ('2026-05-12T23:56:00',))
    con.execute("UPDATE working_memory SET superseded_by=? WHERE id='w3'", ('w3-new',))
    con.execute("INSERT INTO episodic_memory(id,content,source,timestamp,session_id,importance,scope,summary_of,veracity) VALUES (?,?,?,?,?,?,?,?,?)",
                ('e-live-consolidated','Consolidated dashboard memory activity','consolidation','2026-05-12T23:57:00','s6',0.6,'session','w4','tool'))
    con.commit()
    con.close()

    delta = store.realtime_event_delta(seen_ids=seen_state, limit=25)
    by_id = {event['memory_id']: event for event in delta}

    assert by_id['w1']['event_type'] == 'MEMORY_UPDATED'
    assert by_id['w2']['event_type'] == 'MEMORY_RECALLED'
    assert by_id['w3']['event_type'] == 'MEMORY_INVALIDATED'
    assert by_id['e-live-consolidated']['event_type'] == 'MEMORY_CONSOLIDATED'
    assert by_id['w3']['status'] == 'superseded'
    assert all('metadata_json' not in event for event in delta)


def test_pattern_insights_surface_recurring_topics_entities_and_sources(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    store = DashboardStore(db)

    insights = store.pattern_insights(limit=5)

    assert insights['read_only'] is True
    assert insights['summary']['indexed_memories'] >= 1
    assert insights['provider'] == 'mnemosyne.core.PatternDetector'
    assert 'mnemosyne_summary' in insights
    assert {'temporal_patterns', 'content_patterns', 'sequence_patterns'} <= set(insights['mnemosyne_summary'])
    assert 'context_domains' in insights
    assert all(item['label'] != 'Other' for item in insights['context_domains'])
    assert any(item['label'] == 'Unclassified' for item in insights['context_domains'])
    assert any(item['label'] == 'Privacy rules' for item in insights['context_domains'])
    assert any(item['label'] == 'Privacy rule' for item in insights['memory_types'])
    assert any(item['label'] == 'Relationship' for item in insights['memory_types'])
    assert any(item['label'] == 'Direct memory' for item in insights['origins'])
    assert insights['signals'] == []

def test_realtime_event_snapshot_orders_newest_first(tmp_path):
    db = tmp_path / 'mnemosyne.db'
    make_db(db)
    events = DashboardStore(db).realtime_event_snapshot(limit=6)
    timestamps = [event['timestamp'] for event in events]

    assert timestamps == sorted(timestamps, reverse=True)
    assert events[0]['memory_id'] == 'e2'


def test_static_ui_boot_error_diagnostics_and_history_alias_are_present():
    html = (ROOT / 'static' / 'index.html').read_text()
    js = (ROOT / 'static' / 'app.js').read_text()
    css = (ROOT / 'static' / 'style.css').read_text()

    assert 'id="bootError"' in html
    assert 'id="bootErrorStatus"' in html
    assert 'id="bootErrorStack"' in html
    assert 'id="retryBootstrap"' in html
    assert 'id="copyBootError"' in html
    assert "if(tab === 'history') return 'activity';" in js
    assert "history:'activityTimeline'" in js
    assert 'function handleInitError(error)' in js
    assert "fetch('/api/auth/status'" in js
    assert "setBootError('Dashboard failed to finish loading.'" in js
    assert "mnemosyne_triple_add or mnemosyne_remember(... extract=true)" in js
    assert "$('#retryBootstrap').onclick = () => bootstrapDashboard().catch(handleInitError);" in js
    assert "$('#copyBootError').onclick = copyBootErrorDetails;" in js
    assert '.hidden{display:none!important}' in css
    assert '.boot-error-stack{' in css


def test_static_ui_exposes_v23_trust_and_lifecycle_controls():
    html = (ROOT / 'static' / 'index.html').read_text()
    js = (ROOT / 'static' / 'app.js').read_text()
    css = (ROOT / 'static' / 'style.css').read_text()

    assert 'id="veracityBreakdown"' in html
    assert 'id="degradationBreakdown"' in html
    assert 'id="memoryVeracity"' in html
    assert 'id="memoryDegradation"' in html
    assert 'id="memoryTrustPreset"' in html
    assert 'id="review"' in html
    assert 'id="reviewCards"' in html
    assert 'id="reviewQueueSelect"' in html
    assert 'id="reviewQueueCount"' in html
    assert 'id="reviewSearchQuery"' in html
    assert 'id="reviewMinImportance"' in html
    assert 'type="range"' in html
    assert 'id="reviewMinImportanceValue"' in html
    assert 'class="range-filter-value" id="reviewMinImportanceValue"' in html
    assert 'id="reviewLoadMore"' in html
    assert 'id="reviewQueues"' in html
    assert 'id="reviewBulkBar"' in html
    assert 'id="reviewSelectAll"' in html
    assert 'id="reviewConfirm"' in html
    assert 'id="reviewVeracity"' in html
    assert 'id="reviewExpiry"' in html
    assert 'id="reviewExpire"' in html
    assert 'data-tab="memories"' in html
    assert '>Memories<' in html
    assert '>Explore<' not in html
    assert 'data-tab="search"' not in html
    assert 'id="search"' in html
    assert 'id="globalSearchQuery"' in html
    assert 'id="globalSearchButton"' in html
    assert 'id="exploreSearch"' not in html
    assert 'data-panel="exploreSearch"' not in html
    assert 'id="headerSearchQuery"' not in html
    assert 'id="headerSearchButton"' not in html
    assert 'id="menuSearchQuery"' in html
    assert 'id="menuSearchButton"' in html
    assert html.index('id="menuSearchQuery"') < html.index('<nav>')
    assert '.sidebar{max-height:100vh;overflow-y:auto;overscroll-behavior:contain' in css
    assert '.sidebar-menu{padding-bottom:28px}' in css
    assert '.menu-search{margin:12px 0 16px' in css
    assert 'overflow-y:hidden' not in css[css.rfind('/* Desktop sidebar scroll polish */'):]
    assert 'data-tab="explore"' not in html
    assert '>History<' in html
    assert 'chronological memory events + consolidation history' in html
    assert 'not a memory browser' not in html
    assert '>Knowledge Graph<' in html
    assert 'Bulk actions are allowed only for selected active memories' in html
    assert 'id="bulkVeracity"' in html
    assert 'id="bulkExpiry"' in html
    assert 'id="lifecycle"' in html
    assert 'id="lifecycleCards"' in html
    assert 'id="lifecycleQueues"' in html
    assert 'id="lifecycleThresholds"' in html
    assert 'id="todayVeracity"' in html
    assert 'id="todayDegradation"' in html
    assert 'id="constellationFullscreen"' in html
    assert 'id="threeFullscreen"' in html
    assert 'data-tab="palace"' in html
    assert 'data-tab="palace" class="nav-hidden" aria-hidden="true" tabindex="-1"' in html
    assert 'id="memoryPalace"' in html
    assert 'id="palaceViewport"' in html
    assert 'id="palaceSearchQuery"' in html
    assert 'id="palaceSearchButton"' in html
    assert 'id="palaceFullscreen"' in html
    assert 'id="palaceInspector"' in html
    assert 'id="palaceJoystick"' in html
    assert 'WASD' in html
    assert 'Memory Diver' in html
    assert 'LAB v22' in html
    assert 'palace-build' in html
    assert 'Hammy drone' in html
    assert 'Mnemosyne Labyrinth' in html
    assert 'artifact rooms' in html
    assert '/static/app.js?v=stream-v2' in html
    assert '/static/style.css?v=stream-v2' in html
    assert 'id="constellationExitFullscreen"' in html
    assert 'id="threeExitFullscreen"' in html
    assert 'class="fullscreen-exit"' in html
    assert 'toggleVisualiserFullscreen' in js
    assert 'exitVisualiserFullscreen' in js
    assert 'loadMemoryPalace' in js
    assert 'renderMemoryPalace' in js
    assert 'animateMemoryPalace' in js
    assert 'bindPalaceControls' in js
    assert 'clearPalaceScene' in js
    assert 'palaceCreateAvatar' in js
    assert 'palaceSearchBeacon' in js
    assert 'palaceKeys' in js
    assert 'palaceCreateDungeonRooms' in js
    assert 'palaceCreateRoomWalls' in js
    assert 'palaceCreatePortal' in js
    assert 'palaceCreatePedestal' in js
    assert 'palaceCreateArtifactMaterial' in js
    assert 'THREE.BoxGeometry' in js
    assert 'room.floor' in js
    assert 'room.wall' in js
    assert 'palaceCreateRoomEdges' in js
    assert 'palaceIsoRoomLayout' in js
    assert 'palaceFpsRooms' in js
    assert 'palaceFpsAddRoom' in js
    assert 'PerspectiveCamera(72' in js
    assert 'walk forward — memories are grouped by domain' in js
    assert 'new THREE.PlaneGeometry(126, 104)' in js
    assert 'function palaceFpsTexture' in js
    assert 'new THREE.CanvasTexture' in js
    assert "palaceFpsTexturedBasic(THREE, 'stone'" in js
    assert "palaceFpsTexturedBasic(THREE, 'gold'" in js
    assert 'Mobile Chrome crushes subtle StandardMaterial lighting' in js
    assert 'walking straight never drops into blank space' in js
    assert 'Group the first playable walk by memory domain' in js
    assert 'featuredPath' in js
    assert 'Performance-first FPS: shadows and high DPR made desktop unplayably laggy' in js
    assert 'walk forward — memories are grouped by domain' in js
    assert 'tap to scan memory:' in js
    assert 'palaceNearestMemory' in js
    assert 'walk nearer to a memory book, then tap to scan' in js
    assert 'generic graph/entity circles' not in js
    assert 'new THREE.BoxGeometry(44, 54, 8)' in js
    assert 'renderer.shadowMap.enabled = false' in js
    assert 'Spatial streaming-lite' in js
    assert 'palaceApplyVisibilityCulling' in js
    assert 'palaceStreamRelicChunks' in js
    assert 'streamedChunks:new Map()' in js
    assert 'group.removeFromParent()' in js
    assert 'palaceStreamRelicChunks(true)' in js
    assert 'nodes.forEach(n=>palaceFpsAddRelic' not in js
    assert 'lastVisibleObjectCount' in js
    assert 'cullTick % 8' in js
    assert 'slice(0,140)' in js
    assert 'domainGroups' in js
    assert 'round < 20' in js
    assert 'countByCat' in js
    assert 'pathSections' in js
    assert 'Group the first playable walk by memory domain' in js
    assert 'palaceFpsAddPathSections' in js
    assert 'pathGroup' in js
    assert 'kind:\'section\'' in js
    assert 'pathSections.map' in js
    assert 'dead = .16' in js
    assert 'move.lengthSq() > 1' in js
    assert 'rings read as bullseyes' in js
    assert 'new THREE.CircleGeometry(34' not in js
    assert 'new THREE.TorusGeometry(38' not in js
    assert 'mobilePalace ? 430 : 360' in js
    assert 'Math.min(720, memoryPalace.pos.z)' in js
    assert 'Math.max(-1500, Math.min(720, memoryPalace.pos.z))' in js
    assert 'function palaceFpsBox(THREE, scene, size, pos, mat){' in js
    assert 'slice(0,18)' in js
    assert 'slice(0,16)' not in js
    assert 'scene.add(avatar, drone)' not in js
    assert 'scene.add(drone)' in js
    assert 'The Archive Gate' in js
    assert 'Review Wing' in js
    assert 'Episodic Vault' in js
    assert 'Needs-review memory' in js
    assert "e.target.closest('#palaceJoystick')" in js
    assert 'stopPalaceJoystickEvent' in js
    assert 'e.stopPropagation();' in js
    assert "toggleVisualiserFullscreen('#palaceViewport')" in js
    assert "section==='memoryPalace'" in js
    assert "toggleVisualiserFullscreen('#threeViewport')" in js
    assert "toggleVisualiserFullscreen('.constellation-wrap')" in js
    assert "toggleVisualiserFullscreen('#visualiser3d')" not in js
    assert "toggleVisualiserFullscreen('#constellation')" not in js
    assert 'visualiserResponsiveFill' in js
    assert 'threeEffectiveCameraZ' in js
    assert ':fullscreen' in css
    assert '#threeViewport:fullscreen' in css
    assert '.constellation-wrap:fullscreen' in css
    assert '.fullscreen-exit' in css
    assert ':fullscreen .fullscreen-exit' in css
    assert '.palace-viewport' in css
    assert '.palace-hud' in css
    assert '.palace-reticle' in css
    assert '.palace-joystick' in css
    assert '.palace-zone-badge' in css
    assert 'body:has(#memoryPalace.active) main' in css
    assert 'height:100svh' in css
    assert 'position:fixed;left:0;right:0;top:0;z-index:70' in css
    assert 'Joystick to move · drag to look · tap relics' in css
    assert 'width:calc(100% - 20px)' in css
    assert '.palace-labels .three-label{display:none!important}' in css
    assert '.palace-build{display:inline-flex!important' in css
    assert 'mobilePalace ? -.14 : -.10' in js
    assert '.palace-viewport[data-theme="labyrinth"]' in css
    assert '#palaceViewport:fullscreen' in css
    assert '#visualiser3d:fullscreen' not in css
    assert '#constellation:fullscreen' not in css
    assert 'fullscreenchange' in js
    assert 'by_veracity' in js
    assert 'by_degradation' in js
    assert '/api/realtime/status' in js
    assert '/api/runtime/status' in js
    assert 'Installed package' in js
    assert 'Realtime API' in js
    assert 'DeltaSync methods' in js
    assert 'Runtime diagnostics' in html
    assert '/api/realtime/events' in js
    assert 'EventSource' in js
    assert 'data-tab="realtime"' not in html
    assert '<section id="realtime"' not in html
    assert 'Realtime</button>' not in html
    assert 'Recent memories' not in html
    assert 'id="recent"' not in html
    assert 'id="liveStatusCard"' not in html
    assert 'id="liveStatus"' not in html
    assert '<div class="status-label">Memory stream</div>' not in html
    assert 'snapshot events' not in js
    assert 'live ready' not in js
    assert 'poll fallback' not in js
    assert 'realtimeStatusLabel' not in js
    assert 'id="liveMemoryStream"' in html
    assert 'id="liveMemoryLoadMore"' not in html
    assert 'id="liveMemorySentinel"' in html
    assert 'id="liveMemoryStatus"' in html
    assert 'id="patternInsights"' in html
    assert 'id="patternContent"' in html
    assert 'id="patternTemporal"' in html
    assert 'id="patternSequence"' in html
    assert 'id="contextDomains"' in html
    assert 'id="contextDomainBars"' in html
    assert 'Powered by Mnemosyne PatternDetector' in html
    assert 'Dashboard taxonomy' in html
    assert 'renderPatternBars' in js
    assert 'applyPatternFilter' in js
    assert 'data-pattern-kind' in js
    assert 'pattern-bar' in js
    assert '.pattern-bar-fill' in css
    assert '.pattern-summary' in css
    assert '#patternInsights .section-head.mini{display:flex;flex-direction:column;align-items:flex-start;gap:4px}' in css
    assert '#patternInsights .section-head.mini h2{white-space:nowrap;overflow-wrap:normal;word-break:normal}' in css
    assert '#patternInsights .section-head.mini span{text-align:left;white-space:normal;letter-spacing:.12em}' in css
    assert 'Context domains' in html
    assert 'id="patternSignals"' not in html
    assert 'renderPatternSignals' not in js
    assert 'pattern-signal' not in js
    assert 'LIVE_MEMORY_PAGE_SIZE = 25' in js
    assert 'loadLiveMemoryStream(false)' in js
    assert 'loadLiveMemoryStream(true)' in js
    assert 'IntersectionObserver' in js
    assert 'initLiveMemoryInfiniteScroll' in js
    assert 'liveMemoryObserver' in js
    assert "rootMargin:'700px 0px'" in js
    assert 'liveMemoryLoading' in js
    assert "limit: String(LIVE_MEMORY_PAGE_SIZE)" in js
    assert "offset: String(liveMemoryOffset)" in js
    assert "liveMemoryItems.map(memoryItem)" in js
    assert "bindMemoryClicks($('#liveMemoryStream'))" in js
    assert "liveMemoryItems = [item, ...liveMemoryItems.filter(existingItem => existingItem.id !== item.id)];" in js
    assert "].slice(0, Math.max(liveMemoryOffset, LIVE_MEMORY_PAGE_SIZE))" not in js
    assert 'id="settingsDeltaSync"' in html
    assert 'sync diagnostics' in html
    settings_order = ['Password auth', 'Server + database', 'Memory maintenance', 'Database diagnostics', 'Runtime diagnostics', 'Mnemosyne 3.x sync diagnostics']
    settings_section = html[html.index('<section id="settings"'):html.index('</section>', html.index('<section id="settings"'))]
    assert [settings_section.index(label) for label in settings_order] == sorted(settings_section.index(label) for label in settings_order)
    assert '.settings-grid{display:flex;flex-direction:column;gap:22px' in css
    assert '.settings-card{padding:24px' in css
    assert '.settings-card>*+*{margin-top:14px}' in css
    assert '.settings-card .item-actions{margin-top:18px}' in css
    assert '.login-card{width:min(420px,calc(100vw - 32px));max-width:calc(100vw - 32px)}' in css
    assert 'html,body{width:100%;max-width:100%;overflow-x:hidden}' in css
    assert '.runtime-diag-grid{grid-template-columns:repeat(2,minmax(0,1fr))}' in css
    assert 'loadRuntimeDiagnostics' in js
    assert "section==='settings'" in js
    assert '/api/patterns' in js
    assert 'loadPatternInsights' in js
    assert 'renderPatternChips' in js
    assert 'live-badge-new' in js
    assert 'live-badge-updated' in js
    assert 'live-badge-recalled' in js
    assert 'live-badge-invalidated' in js
    assert 'live-badge-consolidated' in js
    assert 'liveEventMeta' in js
    assert 'realtimeStatusCards' not in html
    assert 'realtimeEventFeed' not in html
    assert 'realtimePauseToggle' not in html
    assert 'realtimeRefresh' not in html
    assert 'livePauseToggle' not in html
    assert 'Pause live' not in html
    assert '<h2>Live memory stream</h2>' in html
    assert '<span>25 latest memories</span>' in html
    assert 'Raw memory content is shown because this dashboard is private' not in html
    assert 'private authenticated stream' not in html
    assert 'private and authenticated' not in html
    assert 'metadata-only SSE' not in html
    assert 'sanitized metadata only' not in html
    assert 'metadata_json is still kept out' not in html
    assert '/static/app.js?v=stream-v2' in html
    assert '/static/style.css?v=stream-v2' in html
    assert 'stateHtml' in js
    assert 'state-empty' in css
    assert '.memory-card.live-new' in css
    assert '@keyframes liveGlow' in css
    assert '.live-badge-new' in css
    assert '.live-badge{margin:10px 0 0 0' in css
    assert '.live-badge{margin:10px 0 0 14px' not in css
    assert '.pattern-grid' in css
    assert 'state-loading' in css
    assert 'state-error' in css
    assert 'Search results for' in js
    assert 'reviewReasonBadges' in js
    assert 'review-reasons' in js
    assert 'selectedReviewQueue' in js
    assert 'renderSelectedReviewQueue' in js
    assert 'loadReviewPage' in js
    assert 'reviewOffset' in js
    assert 'REVIEW_PAGE_SIZE = 100' in js
    assert 'min_importance' in js
    assert 'reviewSearchQuery' in js
    assert 'reviewMinImportanceValue' in js
    assert 'updateReviewImportanceLabel' in js
    assert 'actionable selected' not in js
    assert "`${reviewSelection.size} selected`" in js
    assert 'active' not in js[js.index("$('#reviewSelectionStatus').textContent"):js.index("$('#reviewConfirm').disabled")]
    assert "$('#reviewSelectAll').onchange" in js
    assert "latestReviewItems.forEach" in js
    assert "loadReview();" not in js[js.index("$('#reviewSelectAll').onchange"):js.index("$('#reviewClear').onclick")]
    assert "updateReviewBulkBar();" in js[js.index("$('#reviewSelectAll').onchange"):js.index("$('#reviewClear').onclick")]
    select_visible_segment = js[js.index("$$('#review .review-select-visible')"):js.index('function reviewFilterParams')]
    assert 'latestReviewItems.forEach' in select_visible_segment
    assert '$$(\'#review .review-check\')' in select_visible_segment
    assert '/api/review?' in js
    assert 'limit=${REVIEW_PAGE_SIZE}' in js
    assert 'offset=${reviewOffset}' in js
    assert '/api/review?limit=10000' not in js
    assert "Object.entries(queues).map(([key, queue]) => reviewQueueHtml" not in js
    assert 'Needs review' in js
    assert 'Needs confirmation' not in js
    assert 'review non-stated' not in html
    assert 'review non-stated' not in js
    assert 'Lifecycle changes' in js
    assert '>Facts table<' in html
    assert '>Triples table<' not in html
    assert 'contaminated_only' in js
    assert 'degradation_tier' in js
    assert 'trust-strip' in js
    assert 'effective_memory_weight' in js
    assert '/api/review' in js
    assert 'loadReview' in js
    assert 'applyReviewFilter' in js
    assert 'reviewSelection' in js
    assert 'bindReviewControls' in js
    assert 'updateReviewBulkBar' in js
    assert 'confirmSelectedReviewMemories' in js
    assert 'reviewQueueCorrection' not in js
    assert 'Confirm shown' not in js
    assert 'headerSearch' not in js
    assert 'menuSearch' in js
    assert 'switchTab(\'search\')' in js
    assert "search:'explore'" not in js
    assert "exploreSearch:'search'" not in js
    assert "exploreMemories:'memories'" in js
    assert "activeElement.closest('.menu-search')" in js
    assert '/api/lifecycle' in js
    assert 'loadLifecycle' in js
    assert 'lifecycleQueueHtml' in js
    assert 'editVeracity' in js
    assert 'editExpiry' in js
    assert 'bulkVeracity' in js
    assert 'bulkExpiry' in js
    assert 'setSelectedVeracity' in js
    assert 'setSelectedExpiry' in js
    assert 'askVeracity' in js
    assert 'askExpiry' in js
    assert '/api/admin/memory/veracity' in js
    assert '/api/admin/memory/expiry' in js
    assert 'prompt(' not in js
    assert 'contextLabel' in js
    assert "'Temporary context':'Short-term notes'" in js
    assert "'Project context':'Project notes'" in js
    assert 'Short-term notes' in (ROOT / 'dashboard_core.py').read_text()
    assert 'Project notes' in (ROOT / 'dashboard_core.py').read_text()
    assert 'Temporary context' not in (ROOT / 'dashboard_core.py').read_text()
    assert 'Project context' not in (ROOT / 'dashboard_core.py').read_text()
    assert '.menu-search{display:flex' in css
    assert '.menu-search{display:none' not in css
    assert '#today > .cards' in css
    assert '.trust-stated' in css
    assert '.lifecycle-cold' in css


def test_public_config_reports_lan_url_for_wildcard_bind(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'hermes'))
    monkeypatch.setattr('config.lan_host', lambda: '192.168.1.160')
    cfg = save_config(host='0.0.0.0', port=8765)
    assert public_config(cfg)['local_url'] == 'http://127.0.0.1:8765/'
    assert public_config(cfg)['lan_url'] == 'http://192.168.1.160:8765/'


def test_config_validates_port(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'hermes'))
    save_config(port=8765)
    try:
        save_config(port=70000)
    except ValueError as exc:
        assert 'between 1 and 65535' in str(exc)
    else:
        raise AssertionError('invalid port should fail')


def test_admin_mode_allows_localhost_without_password_but_rejects_lan_without_auth(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'hermes'))
    save_config(auth_enabled=False, clear_password=True, host='127.0.0.1')
    cfg = save_config(memory_admin_enabled=True)
    assert public_config(cfg)['memory_admin_enabled'] is True

    try:
        save_config(host='0.0.0.0', auth_enabled=False, memory_admin_enabled=True)
    except ValueError as exc:
        assert 'LAN/non-local' in str(exc)
    else:
        raise AssertionError('LAN admin mode should require password auth')

    cfg = save_config(host='0.0.0.0', password='secret', auth_enabled=True, memory_admin_enabled=True)
    assert public_config(cfg)['memory_admin_enabled'] is True


def test_clear_password_disables_lan_admin_mode_instead_of_throwing(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'hermes'))
    cfg = save_config(host='0.0.0.0', password='secret', auth_enabled=True, memory_admin_enabled=True)
    assert cfg.memory_admin_enabled is True
    assert cfg.has_password is True

    cfg = save_config(clear_password=True)
    assert cfg.auth_enabled is False
    assert cfg.has_password is False
    assert cfg.memory_admin_enabled is False


def test_clear_password_keeps_localhost_admin_mode_allowed(tmp_path, monkeypatch):
    monkeypatch.setenv('HERMES_HOME', str(tmp_path / 'hermes'))
    cfg = save_config(host='127.0.0.1', password='secret', auth_enabled=True, memory_admin_enabled=True)
    assert cfg.memory_admin_enabled is True

    cfg = save_config(clear_password=True)
    assert cfg.auth_enabled is False
    assert cfg.has_password is False
    assert cfg.memory_admin_enabled is True
