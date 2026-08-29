import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ActivityImport, Account, AddonContext, AddonEnableFunction } from '@wealthfolio/addon-sdk';
import { Badge, Button, Checkbox, Input } from '@wealthfolio/ui';
import type { ChangeEvent, DragEvent } from 'react';
import { useEffect, useState } from 'react';
import { convert, detectBroker } from './lib/converters';
import { parseCsv, rowsAsObjects, stringifyActivities } from './lib/csv';
import { activityFromSource, allImportRowNumbers, checkImportInBatches, dateInRange, mergeCheckedActivity, selectImportRows, type CheckedActivity } from './lib/import';
import { markExistingDuplicates, sameDayNonDuplicateReason, type ExistingActivityForDedupe } from './lib/dedupe';
import type { ConversionIssue, NormalizedActivity } from './lib/types';

let addonCtx: AddonContext | undefined;
type TickerResult = { symbol: string; canonicalSymbol?: string; canonicalExchangeMic?: string; exchangeMic?: string; currency?: string; quoteType?: string; providerId?: string; providerSymbol?: string; longName?: string };
const errorMessages = (activity: ActivityImport) => Object.values(activity.errors ?? {}).flat();
const warningMessages = (activity: ActivityImport) => Object.values(activity.warnings ?? {}).flat();
const isDuplicate = (activity: ActivityImport) => Boolean(
  activity.duplicateOfId || activity.duplicateOfLineNumber || activity.warnings?._duplicate?.length,
);

function ImportPage({ ctx }: { ctx: AddonContext }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState('');
  const [fileName, setFileName] = useState('');
  const [broker, setBroker] = useState('');
  const [activities, setActivities] = useState<CheckedActivity[]>([]);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [validated, setValidated] = useState(false);
  const [issues, setIssues] = useState<ConversionIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [importResult, setImportResult] = useState('');
  const [editingSymbol, setEditingSymbol] = useState('');
  const [symbolQuery, setSymbolQuery] = useState('');
  const [symbolResults, setSymbolResults] = useState<TickerResult[]>([]);
  const [mapping, setMapping] = useState<{ accountId: string; fieldMappings: Record<string, string | string[]>; activityMappings: Record<string, string[]>; symbolMappings: Record<string, string>; accountMappings: Record<string, string> } | null>(null);
  const [dedupeWarning, setDedupeWarning] = useState('');
  const [showDedupeExplanation, setShowDedupeExplanation] = useState(false);
  const [sameDayReasons, setSameDayReasons] = useState<Map<number, string>>(new Map());
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    void ctx.api.accounts.getAll().then((items) => {
      const usable = items.filter((item) => item.isActive && item.trackingMode !== 'HOLDINGS');
      setAccounts(usable);
      setAccountId((current) => current || usable.find((item) => item.isDefault)?.id || usable[0]?.id || '');
    }).catch((error) => setMessage(`無法讀取帳戶：${String(error)}`));
  }, [ctx]);

  const selectedAccount = accounts.find((item) => item.id === accountId);
  const hasConversionErrors = issues.some((item) => item.severity === 'error');
  const dateRangeInvalid = Boolean(dateFrom && dateTo && dateFrom > dateTo);
  const visibleActivities = dateRangeInvalid ? [] : activities.filter((activity) => dateInRange(activity.source.date, dateFrom, dateTo));
  const selectedCount = visibleActivities.filter((activity) => selectedRows.has(activity.lineNumber ?? -1)).length;
  const hasValidationErrors = validated && visibleActivities.some((activity) => selectedRows.has(activity.lineNumber ?? -1) && errorMessages(activity).length > 0);
  const importable = visibleActivities.filter((activity) => selectedRows.has(activity.lineNumber ?? -1) && activity.isValid !== false && !errorMessages(activity).length && !isDuplicate(activity));
  const canCommit = Boolean(accountId && validated && importable.length > 0 && visibleActivities.length && !dateRangeInvalid && !hasConversionErrors && !hasValidationErrors && !busy);

  function invalidateValidation() {
    setValidated(false);
    setDedupeWarning('');
    setImportResult('');
    setSameDayReasons(new Map());
  }

  async function validateActivities(rows: NormalizedActivity[], id = accountId) {
    let timezone: string;
    try {
      timezone = (await ctx.api.settings.get()).timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    }
    const selected = selectImportRows(visibleActivities, selectedRows);
    const rawActivities = (rows.length ? rows : selected.map((item) => item.source)).map((row, index) => activityFromSource(row, selected[index]?.lineNumber ?? index + 1, id, timezone));
    const checked = await checkImportInBatches(rawActivities, (batch) => ctx.api.activities.checkImport(batch), (completed, total) => setMessage(`驗證中：已完成 ${completed} / ${total} 筆活動…`));
    // The host may omit addon-only metadata such as lineNumber from its
    // response. Restore the submitted row identity by position before
    // merging validation/deduplication results back into the preview.
    const checkedWithLines = checked.map((activity, index) => {
      const submitted = rawActivities[index];
      return submitted ? mergeCheckedActivity(activity, submitted) : activity;
    });
    // Wealthfolio may return a resolved/canonical symbol (for example VWRA.L as
    // VWRA). Keep the symbol the importer submitted for display and export while
    // retaining the backend-resolved assetId and validation fields.
    const preservedSymbols = checkedWithLines.map((activity, index) => ({ ...activity, symbol: rows[index]?.symbol || activity.symbol }));
    let existing: ExistingActivityForDedupe[] = [];
    let existingReadFailed = false;
    try { existing = await ctx.api.activities.getAll(id) as ExistingActivityForDedupe[]; } catch { existingReadFailed = true; }
    const deduped = markExistingDuplicates(preservedSymbols, existing, id, timezone);
    const byLine = new Map(deduped.map((activity) => [activity.lineNumber ?? -1, activity]));
    const explanations = new Map<number, string>();
    deduped.forEach((activity) => {
      const lineNumber = activity.lineNumber ?? -1;
      if (!isDuplicate(activity)) {
        const reason = sameDayNonDuplicateReason(activity, existing, id, timezone, deduped);
        if (reason) explanations.set(lineNumber, reason);
      }
    });
    setSameDayReasons(explanations);
    const nonImportableLines = new Set(
      deduped
        .filter((activity) => activity.isValid === false || errorMessages(activity).length > 0 || isDuplicate(activity))
        .map((activity) => activity.lineNumber ?? -1),
    );
    setSelectedRows((current) => new Set([...current].filter((lineNumber) => !nonImportableLines.has(lineNumber))));
    setActivities((current) => current.map((activity) => {
      const checked = byLine.get(activity.lineNumber ?? -1);
      return checked ? { ...activity, ...checked, source: activity.source } : activity;
    }));
    setValidated(true);
    setDedupeWarning(existingReadFailed ? '無法讀取既有活動，這次只採用 Wealthfolio 原生去重結果。' : '');
    return deduped;
  }

  async function validateSelected() {
    if (!selectedCount || busy) return;
    setBusy(true); setMessage('');
    try {
      await validateActivities([], accountId);
      setMessage(`已驗證 ${selectedCount} 筆選取活動。`);
    } catch (error) { setValidated(false); setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function readFile(file: File) {
    setBusy(true); setMessage(''); setImportResult(''); setActivities([]); setIssues([]); setSelectedRows(new Set()); setDateFrom(''); setDateTo(''); invalidateValidation();
    try {
      const buffer = await file.arrayBuffer();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      const parsed = parseCsv(text); const detection = detectBroker(parsed.headers);
      if (!detection.broker) throw new Error(`無法辨識 CSV 格式。請確認標題列包含：${detection.missing.join('、')}`);
      const result = convert(detection.broker, rowsAsObjects(parsed));
      let savedMapping: typeof mapping = null;
      try { savedMapping = await ctx.api.activities.getImportMapping(accountId) as typeof mapping; } catch { /* older hosts may not expose mappings */ }
      setMapping(savedMapping);
      const mappedRows = result.activities.map((row) => {
        const sourceSymbol = row.symbol;
        const mappedSymbol = savedMapping?.symbolMappings?.[sourceSymbol];
        return mappedSymbol ? { ...row, sourceSymbol, symbol: mappedSymbol } : { ...row, sourceSymbol };
      });
      setFileName(file.name); setBroker(detection.broker); setIssues(result.issues);
      if (!mappedRows.length) throw new Error('CSV 沒有可匯入的活動');
      const preview = mappedRows.map((row, index) => activityFromSource(row, index + 1, accountId));
      setActivities(preview); setSelectedRows(allImportRowNumbers(preview));
      setMessage(`已讀取 ${result.sourceRows} 筆來源資料，轉換為 ${result.activities.length} 筆活動。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function searchSymbols(query: string) {
    setSymbolQuery(query);
    if (query.trim().length < 1) { setSymbolResults([]); return; }
    try { setSymbolResults(await ctx.api.market.searchTicker(query) as TickerResult[]); } catch (error) { setMessage(`搜尋標的失敗：${String(error)}`); }
  }
  async function selectSymbol(sourceSymbol: string, result: TickerResult) {
    const canonical = result.canonicalSymbol || result.symbol;
    const rows = activities.map((item) => item.source.sourceSymbol === sourceSymbol ? { ...item.source, symbol: canonical, sourceSymbol, exchangeMic: result.canonicalExchangeMic || result.exchangeMic, quoteCcy: result.currency, instrumentType: result.quoteType || item.source.instrumentType, providerId: result.providerId, providerSymbol: result.providerSymbol, symbolName: result.longName } : item.source);
    setBusy(true); setEditingSymbol(''); setSymbolResults([]); invalidateValidation();
    try {
      const nextMapping = { ...(mapping ?? { accountId, fieldMappings: {}, activityMappings: {}, symbolMappings: {}, accountMappings: {} }), accountId, symbolMappings: { ...(mapping?.symbolMappings ?? {}), [sourceSymbol]: canonical } };
      setMapping(nextMapping);
      await ctx.api.activities.saveImportMapping(nextMapping);
      setActivities(rows.map((row, index) => activityFromSource(row, activities[index]?.lineNumber ?? index + 1, accountId)));
    } catch (error) { setMessage(`標的映射失敗：${String(error)}`); } finally { setBusy(false); }
  }
  async function useSymbol(sourceSymbol: string) {
    const symbol = symbolQuery.trim();
    if (!symbol) return;
    const rows = activities.map((item) => item.source.sourceSymbol === sourceSymbol ? { ...item.source, symbol, sourceSymbol } : item.source);
    setBusy(true); setEditingSymbol(''); setSymbolResults([]); invalidateValidation();
    try {
      const nextMapping = { ...(mapping ?? { accountId, fieldMappings: {}, activityMappings: {}, symbolMappings: {}, accountMappings: {} }), accountId, symbolMappings: { ...(mapping?.symbolMappings ?? {}), [sourceSymbol]: symbol } };
      setMapping(nextMapping);
      await ctx.api.activities.saveImportMapping(nextMapping);
      setActivities(rows.map((row, index) => activityFromSource(row, activities[index]?.lineNumber ?? index + 1, accountId)));
    } catch (error) { setMessage(`標的映射失敗：${String(error)}`); } finally { setBusy(false); }
  }
  async function restoreSymbol(sourceSymbol: string) {
    const rows = activities.map((item) => item.source.sourceSymbol === sourceSymbol ? { ...item.source, symbol: sourceSymbol, sourceSymbol, instrumentType: '', exchangeMic: undefined, quoteCcy: undefined, providerId: undefined, providerSymbol: undefined, symbolName: undefined } : item.source);
    setBusy(true); invalidateValidation();
    try {
      const nextSymbols = { ...(mapping?.symbolMappings ?? {}) }; delete nextSymbols[sourceSymbol];
      const nextMapping = { ...(mapping ?? { accountId, fieldMappings: {}, activityMappings: {}, symbolMappings: {}, accountMappings: {} }), accountId, symbolMappings: nextSymbols };
      setMapping(nextMapping); await ctx.api.activities.saveImportMapping(nextMapping); setActivities(rows.map((row, index) => activityFromSource(row, activities[index]?.lineNumber ?? index + 1, accountId)));
    } catch (error) { setMessage(`恢復標的失敗：${String(error)}`); } finally { setBusy(false); }
  }
  function toggleRow(lineNumber: number, checked: boolean) { setSelectedRows((current) => { const next = new Set(current); if (checked) next.add(lineNumber); else next.delete(lineNumber); return next; }); }
  function toggleAll(checked: boolean) {
    const visibleLines = allImportRowNumbers(visibleActivities);
    setSelectedRows((current) => {
      const next = new Set(current);
      visibleLines.forEach((lineNumber) => checked ? next.add(lineNumber) : next.delete(lineNumber));
      return next;
    });
  }
  function onFileChange(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (file) void readFile(file); }
  function onDrop(event: DragEvent<HTMLLabelElement>) { event.preventDefault(); const file = event.dataTransfer.files?.[0]; if (file) void readFile(file); }
  async function download() {
    if (!canCommit || !selectedAccount) return;
    await ctx.api.files.openSaveDialog(stringifyActivities(importable.map((activity) => ({ ...activity.source, account: selectedAccount.name }))), `wealthfolio-${broker || 'activities'}.csv`);
  }
  async function commit() {
    if (!canCommit) return; setBusy(true); setMessage('');
    try {
      const result = await ctx.api.activities.import(importable.map(({ source: _source, ...activity }) => activity));
      setImportResult(`匯入完成：${result.summary.imported} 筆；跳過 ${result.summary.skipped} 筆；重複 ${result.summary.duplicates} 筆；新增資產 ${result.summary.assetsCreated} 筆。`);
    } catch (error) { setMessage(`匯入失敗：${String(error)}`); } finally { setBusy(false); }
  }

  return <div className="p-6 max-w-7xl mx-auto space-y-5">
    <div><h1 className="text-3xl font-bold">對帳單匯入</h1><p className="text-muted-foreground mt-1">支援富邦複委託、永豐、Schwab 與基富通。</p></div>
    <section className="border rounded-lg p-5 space-y-4">
      <label className="block font-medium">1. 選擇 Wealthfolio 帳戶<select className="mt-2 block w-full max-w-lg border rounded px-3 py-2 bg-background" value={accountId} onChange={(event) => { setAccountId(event.target.value); setActivities([]); setSelectedRows(new Set()); setFileName(''); setBroker(''); setIssues([]); setImportResult(''); setDateFrom(''); setDateTo(''); invalidateValidation(); }} disabled={busy}>
        <option value="">請選擇帳戶</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}（{account.currency}）</option>)}
      </select></label>
      <label className="block font-medium" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>2. 上傳 CSV
        <span className="mt-2 flex min-h-24 cursor-pointer items-center justify-center rounded border-2 border-dashed p-5 text-sm text-muted-foreground">{fileName || '拖放 CSV 到這裡，或點擊選擇檔案'}<input className="sr-only" type="file" accept=".csv,text/csv" onChange={onFileChange} disabled={!accountId || busy} /></span>
      </label>
      {busy && <p className="text-sm">處理中…</p>}{message && <p className="rounded bg-muted p-3 text-sm">{message}</p>}{importResult && <p className="rounded bg-green-50 p-3 text-sm text-green-800">{importResult}</p>}
    </section>
    {activities.length > 0 && <section className="border rounded-lg p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-4 text-sm"><span>來源：{broker}</span><span>活動：{activities.length}</span><span>顯示：{visibleActivities.length}</span><span>已選取：{selectedCount}</span><Badge variant={validated ? (hasValidationErrors ? 'destructive' : 'default') : 'secondary'}>{validated ? (hasValidationErrors ? '有驗證錯誤' : '驗證完成') : '待驗證'}</Badge></div>
      {issues.length > 0 && <div className="rounded bg-yellow-50 p-3 text-sm"><p className="font-medium">轉換訊息</p>{issues.map((item, index) => <p key={`${item.lineNumber}-${index}`}>{item.lineNumber ? `第 ${item.lineNumber} 列：` : ''}{item.message}</p>)}</div>}
      <div className="flex flex-wrap items-end gap-3"><label className="text-sm">起日<Input className="mt-1 w-44" type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); invalidateValidation(); }} disabled={busy} /></label><label className="text-sm">迄日<Input className="mt-1 w-44" type="date" value={dateTo} onChange={(event) => { setDateTo(event.target.value); invalidateValidation(); }} disabled={busy} /></label><Button variant="outline" onClick={() => { setDateFrom(''); setDateTo(''); invalidateValidation(); }} disabled={busy || (!dateFrom && !dateTo)}>清除日期</Button>{dateRangeInvalid && <span className="text-sm text-red-600">起日不可晚於迄日</span>}</div>
      <div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-2 text-sm"><Checkbox checked={visibleActivities.length > 0 && selectedCount === visibleActivities.length} onCheckedChange={(checked) => toggleAll(checked === true)} disabled={busy || !visibleActivities.length} />全選／取消全選篩選結果</label><label className="flex items-center gap-2 text-sm"><Checkbox checked={showDedupeExplanation} onCheckedChange={(checked) => setShowDedupeExplanation(checked === true)} disabled={busy} />顯示同日同標的未重複原因</label><span className="text-sm text-muted-foreground">驗證與匯入只會處理目前日期範圍內的已選取活動。</span><Button onClick={() => void validateSelected()} disabled={!selectedCount || busy || dateRangeInvalid}>{busy ? '處理中…' : `驗證選取的 ${selectedCount} 筆`}</Button></div>
      {dedupeWarning && <p className="rounded bg-yellow-50 p-3 text-sm text-yellow-800">{dedupeWarning}</p>}
      <div className="overflow-auto max-h-[32rem]"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-2"><span className="sr-only">選取</span></th><th className="p-2">日期</th><th className="p-2">活動</th><th className="p-2">標的</th><th className="p-2">數量</th><th className="p-2">價格</th><th className="p-2">金額</th><th className="p-2">費用／稅費</th><th className="p-2 w-32">狀態</th></tr></thead><tbody>{visibleActivities.map((activity, index) => { const errors = errorMessages(activity); const warnings = warningMessages(activity); const sourceSymbol = activity.source.sourceSymbol || activity.source.symbol; const canMap = Boolean(sourceSymbol) && !['DEPOSIT', 'WITHDRAWAL', 'FEE', 'TAX', 'CREDIT', 'INTEREST'].includes(String(activity.activityType)); const lineNumber = activity.lineNumber ?? index + 1; const selected = selectedRows.has(lineNumber); const explanation = showDedupeExplanation ? sameDayReasons.get(lineNumber) : undefined; const status = !selected ? '未選取' : !validated ? '待驗證' : isDuplicate(activity) ? '重複，將跳過' : errors.length ? errors.join('；') : warnings.length ? warnings.join('；') : explanation || '可匯入'; const statusClass = !selected ? 'text-muted-foreground' : errors.length ? 'text-red-600' : warnings.length || explanation ? 'text-yellow-700' : ''; return <tr key={`${lineNumber}-${index}`} className="border-b align-top"><td className="p-2"><Checkbox checked={selected} onCheckedChange={(checked) => toggleRow(lineNumber, checked === true)} disabled={busy} /></td><td className="p-2">{activity.source.date}</td><td className="p-2">{activity.activityType}</td><td className="p-2">{canMap ? <div><Button variant="link" className="h-auto p-0" onClick={() => { setEditingSymbol(sourceSymbol); setSymbolQuery(activity.symbol || sourceSymbol); }} disabled={busy}>{activity.source.sourceSymbol !== activity.symbol ? `${sourceSymbol} → ` : ''}{activity.symbol || '—'}</Button>{editingSymbol === sourceSymbol && <div className="mt-1 min-w-64 space-y-1"><Input value={symbolQuery} onChange={(event) => void searchSymbols(event.target.value)} placeholder="搜尋標的或輸入完整代號" />{symbolResults.slice(0, 6).map((item) => <Button variant="ghost" className="block h-auto w-full justify-start p-1" key={`${item.symbol}-${item.exchangeMic}`} onClick={() => void selectSymbol(sourceSymbol, item)}>{item.providerSymbol || item.canonicalSymbol || item.symbol} {item.longName ? `— ${item.longName}` : ''}</Button>)}{symbolQuery.trim() && <Button variant="outline" className="h-auto w-full justify-start p-1" onClick={() => void useSymbol(sourceSymbol)}>使用此代號：{symbolQuery.trim()}</Button>}{activity.source.sourceSymbol !== activity.symbol && <Button variant="link" className="h-auto p-0 text-xs" onClick={() => void restoreSymbol(sourceSymbol)}>恢復原始代號</Button>}</div>}</div> : '—'}</td><td className="p-2">{activity.quantity || '—'}</td><td className="p-2">{activity.unitPrice || '—'}</td><td className="p-2">{activity.amount || '—'}</td><td className="p-2">{activity.fee || '—'}</td><td className="p-2 w-32 max-w-32"><div className={`truncate whitespace-nowrap ${statusClass}`} title={status}>{status}</div></td></tr>; })}</tbody></table></div>
      <div className="flex gap-3"><Button variant="outline" onClick={() => void download()} disabled={!canCommit}>下載 Wealthfolio CSV</Button><Button onClick={() => void commit()} disabled={!canCommit}>確認匯入（{importable.length} 筆）</Button></div>
    </section>}
  </div>;
}

const AddonRoute = () => <QueryClientProvider client={addonCtx!.api.query.getClient() as QueryClient}><ImportPage ctx={addonCtx!} /></QueryClientProvider>;
const enable: AddonEnableFunction = (ctx) => { addonCtx = ctx; ctx.router.add({ id: 'wealthfolio-statement-importer', path: '/addons/wealthfolio-statement-importer', component: AddonRoute }); ctx.onDisable(() => { addonCtx = undefined; }); };
export default enable;
