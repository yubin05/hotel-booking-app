import { CheckCircle2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { Loading } from '../components/ui';

// 토스 결제창이 successUrl로 돌려준 값(paymentKey · orderId · amount)으로 서버에 승인을 요청한다.
// 금액은 서버가 예약 금액과 다시 맞춰 본다. 새로 고침해 다시 보내도 서버가 한 번만 처리한다
export function PaymentSuccessPage() {
  const [params] = useSearchParams();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    const body = { paymentKey: params.get('paymentKey'), orderId: params.get('orderId'), amount: Number(params.get('amount')) };
    api('/payments/confirm', { method: 'POST', body }).then(
      () => setResult({ ok: true, message: '결제가 완료되어 예약이 확정되었어요.' }),
      (err: Error) => setResult({ ok: false, message: err.message }),
    );
  }, [params]);

  if (!result) return <Loading label="결제를 승인하는 중…" />;
  return <ResultBox ok={result.ok} message={result.message} />;
}

// 결제창에서 취소하거나 카드사가 거절한 경우. 결제 대기 10분 안이면 내 예약에서 다시 결제할 수 있다
export function PaymentFailPage() {
  const [params] = useSearchParams();
  return <ResultBox ok={false} message={params.get('message') ?? '결제를 마치지 못했어요.'} />;
}

function ResultBox({ ok, message }: { ok: boolean; message: string }) {
  return (
    <div className="mx-auto max-w-md px-4 py-20 text-center">
      {ok ? (
        <CheckCircle2 size={44} className="mx-auto text-teal-600" aria-hidden />
      ) : (
        <XCircle size={44} className="mx-auto text-rose-500" aria-hidden />
      )}
      <p className="mt-4 text-lg font-bold">{ok ? '결제 완료' : '결제하지 못했어요'}</p>
      <p className="mt-2 text-slate-600">{message}</p>
      {!ok && <p className="mt-1 text-sm text-slate-500">예약 후 10분 안에는 내 예약에서 다시 결제할 수 있어요.</p>}
      <Link to="/me/bookings" className="btn-primary mt-6">
        내 예약 보기
      </Link>
    </div>
  );
}
