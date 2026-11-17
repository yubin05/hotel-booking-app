import { format, parseISO } from 'date-fns';
import { useApi, type PointTransaction, type Points } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading, LoginRequired, PageTitle } from '../components/ui';
import { won } from '../format';

const TYPE_LABEL: Record<PointTransaction['type'], string> = {
  earn: '적립',
  use: '사용',
  refund: '환원 (예약 취소 · 변경)',
  restore: '복구',
};

export function PointsPage() {
  const { user, openAuth } = useAuth();
  const points = useApi<Points>(user ? '/points' : null);

  if (!user) return <LoginRequired onLogin={openAuth} message="로그인하면 적립금을 확인할 수 있어요." />;

  return (
    <div className="mx-auto max-w-3xl px-4 pt-6">
      <PageTitle sub="숙박을 마치면 결제 금액의 5%가 적립되고, 예약할 때 결제 금액까지 쓸 수 있어요.">내 적립금</PageTitle>
      {points.loading && !points.data && <Loading />}
      {points.error && <ErrorBox message={points.error} onRetry={points.reload} />}
      {points.data && (
        <>
          <section className="card mb-6 p-5">
            <p className="text-sm text-slate-500">사용할 수 있는 적립금</p>
            <p className="text-3xl font-extrabold text-teal-700">{won(points.data.balance)}</p>
          </section>
          <h2 className="mb-3 text-lg font-extrabold">내역</h2>
          {points.data.transactions.length === 0 ? (
            <p className="text-slate-500">아직 내역이 없어요.</p>
          ) : (
            <ul className="card divide-y divide-slate-100">
              {points.data.transactions.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="font-medium">{TYPE_LABEL[t.type]}</p>
                    <p className="truncate text-xs text-slate-500">
                      {format(parseISO(t.created_at), 'yyyy.M.d HH:mm')}
                      {t.hotel_name && ` · ${t.hotel_name}`}
                    </p>
                  </div>
                  <span className={`ml-auto shrink-0 font-bold ${t.amount < 0 ? 'text-slate-700' : 'text-teal-700'}`}>
                    {t.amount < 0 ? '-' : '+'}
                    {won(Math.abs(t.amount))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-slate-400">최근 50건까지 보여요.</p>
        </>
      )}
    </div>
  );
}
