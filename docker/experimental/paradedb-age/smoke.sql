\set ON_ERROR_STOP on

SELECT current_setting('server_version_num') AS server_version_num;

SELECT name, default_version, installed_version
FROM pg_available_extensions
WHERE name IN ('age', 'pg_search', 'vector')
ORDER BY name;

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_search;
CREATE EXTENSION IF NOT EXISTS age;

LOAD 'age';
SET search_path = ag_catalog, "$user", public;

SELECT ag_catalog.create_graph('sourceweft_retrieval_smoke');

SELECT *
FROM cypher('sourceweft_retrieval_smoke', $$
  CREATE
    (api:Document {
      id: 'doc_api',
      title: 'Model gateway API reference',
      team_id: 'team_alpha',
      workspace_id: 'workspace_docs'
    }),
    (billing:Document {
      id: 'doc_billing',
      title: 'Billing lifecycle runbook',
      team_id: 'team_alpha',
      workspace_id: 'workspace_docs'
    }),
    (notion:Document {
      id: 'doc_notion',
      title: 'Notion connector sync guide',
      team_id: 'team_alpha',
      workspace_id: 'workspace_docs'
    }),
    (recipe:Document {
      id: 'doc_recipe',
      title: 'Office lunch recipes',
      team_id: 'team_beta',
      workspace_id: 'workspace_misc'
    }),
    (gateway:Concept {name: 'Model Gateway'}),
    (usage:Concept {name: 'Usage Ledger'}),
    (connector:Concept {name: 'Connector Sync'}),
    (food:Concept {name: 'Recipe'}),
    (api)-[:MENTIONS {weight: 0.91}]->(gateway),
    (billing)-[:MENTIONS {weight: 0.86}]->(usage),
    (notion)-[:MENTIONS {weight: 0.88}]->(connector),
    (recipe)-[:MENTIONS {weight: 0.77}]->(food),
    (notion)-[:RELATED_TO {reason: 'uses gateway for embeddings'}]->(api),
    (api)-[:RELATED_TO {reason: 'usage metering'}]->(billing)
$$) AS (result agtype);

SELECT *
FROM cypher('sourceweft_retrieval_smoke', $$
  MATCH (d:Document {id: 'doc_api'})-[:MENTIONS]->(c:Concept)
  RETURN d.id, c.name
$$) AS (document_id agtype, concept_name agtype);

DO $$
DECLARE
  direct_concepts text[];
  related_documents text[];
  unrelated_count integer;
BEGIN
  SELECT array_agg(concept_name::text ORDER BY concept_name::text)
  INTO direct_concepts
  FROM cypher('sourceweft_retrieval_smoke', $cypher$
    MATCH (d:Document {id: 'doc_api'})-[:MENTIONS]->(c:Concept)
    RETURN c.name
  $cypher$) AS (concept_name agtype);

  IF direct_concepts IS DISTINCT FROM ARRAY['Model Gateway'] THEN
    RAISE EXCEPTION 'AGE direct concept retrieval failed: %', direct_concepts;
  END IF;

  SELECT array_agg(document_id::text ORDER BY document_id::text)
  INTO related_documents
  FROM cypher('sourceweft_retrieval_smoke', $cypher$
    MATCH (start:Document {id: 'doc_notion'})-[:RELATED_TO]->(related:Document)-[:MENTIONS]->(:Concept {name: 'Model Gateway'})
    RETURN related.id
  $cypher$) AS (document_id agtype);

  IF related_documents IS DISTINCT FROM ARRAY['doc_api'] THEN
    RAISE EXCEPTION 'AGE two-hop related document retrieval failed: %', related_documents;
  END IF;

  SELECT count(*)
  INTO unrelated_count
  FROM cypher('sourceweft_retrieval_smoke', $cypher$
    MATCH (d:Document {team_id: 'team_alpha'})-[:MENTIONS]->(:Concept {name: 'Recipe'})
    RETURN d.id
  $cypher$) AS (document_id agtype);

  IF unrelated_count != 0 THEN
    RAISE EXCEPTION 'AGE negative retrieval failed: expected 0 Recipe docs in team_alpha, got %', unrelated_count;
  END IF;
END $$;

DROP TABLE IF EXISTS vector_smoke;
CREATE TABLE vector_smoke (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  embedding vector(3) NOT NULL
);

INSERT INTO vector_smoke (embedding)
VALUES ('[1,0,0]'), ('[0,1,0]'), ('[0,0,1]');

CREATE INDEX vector_smoke_embedding_hnsw_idx
ON vector_smoke USING hnsw (embedding vector_cosine_ops);

SELECT id, embedding <=> '[1,0,0]'::vector AS distance
FROM vector_smoke
ORDER BY distance
LIMIT 1;

DROP TABLE IF EXISTS bm25_smoke;
CREATE TABLE bm25_smoke (
  id text PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  workspace_id text NOT NULL
);

INSERT INTO bm25_smoke (id, title, description, workspace_id)
VALUES
  (
    'doc_api',
    'Model gateway API reference',
    'OpenAI compatible gateway routes requests to provider models and records embeddings.',
    'workspace_docs'
  ),
  (
    'doc_billing',
    'Billing lifecycle runbook',
    'Usage ledger, invoices, seats, trials, and subscription billing operations.',
    'workspace_docs'
  ),
  (
    'doc_notion',
    'Notion connector sync guide',
    'Connector sync imports Notion pages, preserves source metadata, and schedules retrieval indexing.',
    'workspace_docs'
  ),
  (
    'doc_recipe',
    'Office lunch recipes',
    'Pasta salad with tomatoes, basil, and olive oil for a team lunch.',
    'workspace_misc'
  );

CREATE INDEX bm25_smoke_idx
ON bm25_smoke
USING bm25 (id, title, description, workspace_id)
WITH (key_field = 'id');

SELECT id, title
FROM bm25_smoke
WHERE description ||| 'connector sync'
ORDER BY id;

DO $$
DECLARE
  connector_hits text[];
  billing_hits text[];
  workspace_hits text[];
  lunch_hits text[];
BEGIN
  SELECT array_agg(id ORDER BY id)
  INTO connector_hits
  FROM bm25_smoke
  WHERE description ||| 'connector sync';

  IF connector_hits IS DISTINCT FROM ARRAY['doc_notion'] THEN
    RAISE EXCEPTION 'BM25 connector retrieval failed: %', connector_hits;
  END IF;

  SELECT array_agg(id ORDER BY id)
  INTO billing_hits
  FROM bm25_smoke
  WHERE description ||| 'usage ledger subscription';

  IF billing_hits IS DISTINCT FROM ARRAY['doc_billing'] THEN
    RAISE EXCEPTION 'BM25 billing retrieval failed: %', billing_hits;
  END IF;

  SELECT array_agg(id ORDER BY id)
  INTO workspace_hits
  FROM bm25_smoke
  WHERE workspace_id ||| 'workspace_docs';

  IF workspace_hits IS DISTINCT FROM ARRAY['doc_api', 'doc_billing', 'doc_notion'] THEN
    RAISE EXCEPTION 'BM25 workspace field retrieval failed: %', workspace_hits;
  END IF;

  SELECT array_agg(id ORDER BY id)
  INTO lunch_hits
  FROM bm25_smoke
  WHERE description ||| 'lunch';

  IF lunch_hits IS DISTINCT FROM ARRAY['doc_recipe'] THEN
    RAISE EXCEPTION 'BM25 negative/domain separation retrieval failed: %', lunch_hits;
  END IF;
END $$;
