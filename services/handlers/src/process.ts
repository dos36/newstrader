import type { SQSEvent } from 'aws-lambda';

/** Lambda entry: consume q-items pointer messages → dedup/cluster. Filled in by M0 wiring. */
export const handler = async (_event: SQSEvent): Promise<void> => {
  throw new Error('not implemented yet');
};
