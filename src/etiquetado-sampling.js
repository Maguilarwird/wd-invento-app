export const PROD_SAMPLE_DEFAULT = 50;
export const PROD_SAMPLE_MAX = 200;

export function selectDeterministicSampleIndices(totalRows, requestedSize) {
  const total = Math.max(0, Math.floor(Number(totalRows) || 0));
  const size = Math.min(
    total,
    PROD_SAMPLE_MAX,
    Math.max(1, Math.floor(Number(requestedSize) || PROD_SAMPLE_DEFAULT)),
  );

  if (total === 0) return [];
  if (size >= total) return Array.from({ length: total }, (_, index) => index);
  if (size === 1) return [Math.floor(total / 2)];

  return Array.from(
    { length: size },
    (_, position) => Math.round((position * (total - 1)) / (size - 1)),
  );
}
