import { useState } from 'react';
import { api, useApi, type HostBooking, type Pagination } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading, LoginRequired, PageTitle } from '../components/ui';
import { shortDate, won } from '../format';
import { useToast } from '../toast';

const STATUS_LABEL: Record<HostBooking['status'], [string, string]> = {
  confirmed: ['예약 확정', 'bg-teal-50 text-teal-700'],
  completed: ['숙박 완료', 'bg-slate-100 text-slate-600'],
  cancelled: ['취소', 'bg-slate-100 text-slate-400'],
};

// 숙소 주인 화면: 내 숙소 예약 목록 + 숙박 완료(체크아웃) 버튼 (인프라 ADR-058)
export function HostPage() {
  const { user, openAuth } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<HostBooking['status']>('confirmed');
  const [page, setPage] = useState(1);
  const isHost = user?.role === 'host';
  const list = useApi<{ bookings: HostBooking[]; pagination: Pagination }>(
    isHost ? `/host/bookings?status=${status}&page=${page}` : null,
  );
  const [busy, setBusy] = useState('');

  if (!user) return <LoginRequired onLogin={openAuth} message="숙소 주인 계정으로 로그인해 주세요." />;
  if (!isHost) {
    return (
      <div className="mx-auto max-w-5xl px-4 pt-6">
        <ErrorBox message="숙소 주인 계정만 볼 수 있어요." />
      </div>
    );
  }

  async function complete(b: HostBooking) {
    setBusy(b.id);
    try {
      const data = await api<{ points_earned: number }>(`/host/bookings/${b.id}/complete`, { method: 'POST' });
      toast(`숙박 완료로 바꿨어요. ${b.guest_name}님에게 적립금 ${won(data.points_earned)}이 쌓였어요.`, 'success');
      list.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy('');
    }
  }

  const pagination = list.data?.pagination;
  return (
    <div className="mx-auto max-w-5xl px-4 pt-6">
      <PageTitle sub="체크인 날짜가 된 예약은 손님이 떠난 뒤 숙박 완료로 바꿔 주세요. 손님에게 결제 금액의 5%가 적립돼요.">
        내 숙소 예약
      </PageTitle>
      <div className="mb-4 flex gap-2" role="group" aria-label="예약 상태">
        {(Object.keys(STATUS_LABEL) as HostBooking['status'][]).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold ${
              status === s ? 'border-teal-600 bg-teal-50 text-teal-700' : 'border-slate-200 text-slate-600'
            }`}
          >
            {STATUS_LABEL[s][0]}
          </button>
        ))}
      </div>

      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {list.data?.bookings.length === 0 && <p className="text-slate-500">예약이 없어요.</p>}
      <ul className="space-y-3">
        {list.data?.bookings.map((b) => (
          <li key={b.id} className="card flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold">
                {b.hotel_name} · {b.room_name}
              </p>
              <p className="text-sm text-slate-600">
                {shortDate(b.check_in_date)} ~ {shortDate(b.check_out_date)} · {b.guests}명 · {won(b.total_price)}
              </p>
              <p className="text-sm text-slate-600">
                {b.guest_name} · {b.guest_phone ?? '전화번호 없음'} · {b.guest_email}
              </p>
              {b.special_requests && <p className="mt-1 text-xs text-slate-500">요청: {b.special_requests}</p>}
            </div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_LABEL[b.status][1]}`}>
              {STATUS_LABEL[b.status][0]}
            </span>
            {b.status === 'confirmed' && (
              <button
                type="button"
                className="btn-primary shrink-0 py-2 text-sm"
                disabled={!b.can_complete || busy === b.id}
                title={b.can_complete ? undefined : '체크인 날짜부터 바꿀 수 있어요'}
                onClick={() => complete(b)}
              >
                {busy === b.id ? '처리 중…' : '숙박 완료'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {pagination && pagination.total_pages > 1 && (
        <nav className="mt-6 flex items-center justify-center gap-3 text-sm" aria-label="쪽 이동">
          <button type="button" className="btn-outline py-1.5" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            이전
          </button>
          <span>
            {page} / {pagination.total_pages}
          </span>
          <button
            type="button"
            className="btn-outline py-1.5"
            disabled={page >= pagination.total_pages}
            onClick={() => setPage(page + 1)}
          >
            다음
          </button>
        </nav>
      )}
    </div>
  );
}
