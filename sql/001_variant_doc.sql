-- =============================================================================
-- cars-data.com API — read-model: variant_doc
-- Copied from specs/api/variant-specs-flat.sql (validated on cars_v3, 2026-06-02),
-- re-run here 2026-07-26 against local cars_v3 for Phase 1 API dev.
-- =============================================================================

DROP MATERIALIZED VIEW IF EXISTS variant_doc;

CREATE MATERIALIZED VIEW variant_doc AS
SELECT
  v.public_id AS variant_id,
  v.generation_id,
  jsonb_object_agg(
    sc.spec_key,
    jsonb_strip_nulls(jsonb_build_object(
      'v', CASE
             WHEN sv.value_number  IS NOT NULL THEN to_jsonb(sv.value_number)
             WHEN sv.value_boolean IS NOT NULL THEN to_jsonb(sv.value_boolean)
             WHEN sv.value_enum    IS NOT NULL THEN to_jsonb(sv.value_enum)
             ELSE to_jsonb(sv.value_text)
           END,
      'u', sc.unit,
      'e', sv.value_enum,
      'c', CASE WHEN sv.confidence < 1.0 THEN sv.confidence ELSE NULL END
    ))
  ) AS specs,
  count(*)::int AS spec_count
FROM variants v
JOIN spec_values sv ON sv.entity_kind = 'variant' AND sv.entity_id = v.public_id
JOIN specs_catalog sc ON sc.id = sv.spec_id AND sc.is_active
WHERE v.is_active
GROUP BY v.public_id, v.generation_id;

CREATE UNIQUE INDEX idx_variant_doc_pk ON variant_doc (variant_id);
CREATE INDEX idx_variant_doc_gen ON variant_doc (generation_id);

-- Refresh at end of each data sync:
--   REFRESH MATERIALIZED VIEW CONCURRENTLY variant_doc;
