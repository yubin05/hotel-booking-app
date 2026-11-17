import { format, parseISO } from 'date-fns';
import { useState, type FormEvent } from 'react';
import { api, type AdminUserView, type PointTransaction } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, LoginRequired, PageTitle } from '../components/ui';
import { won } from '../format';
import { useToast } from '../toast';

const TYPE_LABEL: Record<PointTransaction['type'], string> = { earn: '적립', use: '사용', refund: '환원', restore: '복구' };

// 운영자 화면 (인프라 ADR-058 · ADR-060): 계정을 찾아 적립금 내역을 세션 번호별로 보고, 공격자 세션이 쓴 적립금을 복구한다
export function AdminPage() {
  const { user, openAuth } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [view, setView] = useState<AdminUserView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!user) return <LoginRequired onLogin={openAuth} message="관리자 계정으로 로그인해 주세요." />;
  if (user.role !== 'admin') {
    return (
      <div className="mx-auto max-w-5xl px-4 pt-6">
        <ErrorBox message="관리자만 볼 수 있어요." />
      </div>
    );
  }

  async function search(target = email) {
    setError('');
    try {
      setView(await api<AdminUserView>(`/admin/users?email=${encodeURIComponent(target.trim())}`));
    } catch (err) {
      setView(null);
      setError((err as Error).message);
    }
  }

  async function recover(sessionId: string) {
    if (!window.confirm(`세션 ${sessionId.slice(0, 8)}…이 쓴 적립금을 모두 되돌리고, 그 적립금으로 만든 예약을 취소할까요?`)) return;
    setBusy(true);
    try {
      const data = await api<{ restored_amount: number; cancelled_bookings: string[] }>('/admin/recover', {
        method: 'POST',
        body: { session_id: sessionId },
      });
      toast(`적립금 ${won(data.restored_amount)} 복구, 예약 ${data.cancelled_bookings.length}건 취소`, 'success');
      await search(view!.user.email);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 pt-6">
      <PageTitle sub="계정을 찾아 적립금이 어느 로그인 세션에서 쓰였는지 보고, 공격자 세션이 쓴 적립금을 되돌립니다.">관리자</PageTitle>
      <form
        className="mb-6 flex gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="손님 이메일"
          aria-label="손님 이메일"
          className="input"
        />
        <button type="submit" className="btn-primary shrink-0">
          찾기
        </button>
      </form>
      {error && <ErrorBox message={error} />}

      {view && (
        <>
          <section className="card mb-6 flex flex-wrap items-center gap-x-6 gap-y-1 p-5">
            <p className="font-bold">
              {view.user.name} <span className="font-normal text-slate-500">({view.user.role})</span>
            </p>
            <p className="text-sm text-slate-600">{view.user.email}</p>
            <p className="ml-auto text-lg font-extrabold text-teal-700">잔액 {won(view.points.balance)}</p>
          </section>
          <h2 className="mb-3 text-lg font-extrabold">적립금 내역 (최근 100건)</h2>
          {view.points.transactions.length === 0 && <p className="text-slate-500">내역이 없어요.</p>}
          <ul className="card divide-y divide-slate-100">
            {view.points.transactions.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
                <span className="w-10 shrink-0 font-semibold">{TYPE_LABEL[t.type]}</span>
                <span className={`w-24 shrink-0 text-right font-bold ${t.amount < 0 ? 'text-slate-700' : 'text-teal-700'}`}>
                  {t.amount < 0 ? '-' : '+'}
                  {won(Math.abs(t.amount))}
                </span>
                <span className="min-w-0 flex-1 truncate text-slate-600">
                  {format(parseISO(t.created_at), 'yyyy.M.d HH:mm')}
                  {t.hotel_name && ` · ${t.hotel_name}`}
                  {t.booking_status && ` (${t.booking_status})`}
                </span>
                <code className="shrink-0 text-xs text-slate-500" title={t.session_id ?? ''}>
                  세션 {t.session_id ? `${t.session_id.slice(0, 8)}…` : '없음'}
                </code>
                {t.type === 'use' && !t.reversed && t.session_id && (
                  <button type="button" className="btn-outline shrink-0 py-1 text-xs" disabled={busy} onClick={() => recover(t.session_id!)}>
                    이 세션 복구
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
