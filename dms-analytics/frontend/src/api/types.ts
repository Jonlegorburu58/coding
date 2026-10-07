import type { components } from './schema';

type S = components['schemas'];

export type Health = S['Health'];
export type Session = S['Session'];
export type SignInStart = S['SignInStart'];
export type SyncRun = S['SyncRun'];
export type SyncStatus = S['SyncStatus'];
export type PersonRef = S['PersonRef'];
export type Filters = S['Filters'];
export type ControlDef = S['ControlDef'];
export type ControlStatus = S['ControlStatus'];
export type ControlTally = S['ControlTally'];
export type PortfolioSummary = S['PortfolioSummary'];
export type Breakdown = S['Breakdown'];
export type BreakdownRow = Breakdown['rows'][number];
export type BreakdownCell = S['BreakdownCell'];
export type Trend = S['Trend'];
export type TrendPoint = Trend['points'][number];
export type MatterSummary = S['MatterSummary'];
export type MatterPage = S['MatterPage'];
export type MatterDetail = S['MatterDetail'];
export type ControlResult = S['ControlResult'];
export type EvidenceDoc = S['EvidenceDoc'];
export type TimelineEvent = MatterDetail['timeline'][number];
export type DocTypeCount = MatterDetail['doc_type_counts'][number];
export type ExceptionItem = S['ExceptionItem'];
export type ExceptionPage = S['ExceptionPage'];
export type KeyDate = S['KeyDate'];
export type LexcelSample = S['LexcelSample'];
export type Settings = S['Settings'];
export type SettingsUpdate = S['SettingsUpdate'];
export type ApiErrorBody = S['Error'];

export type Dimension = 'practice_area' | 'partner' | 'fee_earner' | 'office' | 'opened_month';
export type SyncKind = 'auto' | 'full' | 'reconcile';
export type MatterSort =
  | 'risk_desc'
  | 'risk_asc'
  | 'opened_desc'
  | 'opened_asc'
  | 'activity_desc'
  | 'activity_asc'
  | 'matter_code';
export type ExceptionSort = 'severity_desc' | 'days_late_desc' | 'opened_desc';
export type FailingStatus = 'late' | 'missing' | 'stale';
