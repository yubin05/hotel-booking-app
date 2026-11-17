import { loadTossPayments } from '@tosspayments/tosspayments-sdk';
import { api } from './api';

export interface PendingPayment {
  orderId: string;
  amount: number;
  orderName: string;
}

// 토스 결제창(테스트 키)으로 보낸다. 카드 번호는 토스 창에만 입력되고, 끝나면 /payments/success로 돌아와 서버가 승인한다
// (서버 docs/decisions.md APP-001). 승인 전까지 예약은 10분 동안 "결제 대기"
export async function startPayment(p: PendingPayment, customer: { id: string; name: string; email: string }): Promise<void> {
  const { client_key } = await api<{ enabled: boolean; client_key: string | null }>('/payments/config');
  if (!client_key) throw new Error('결제 설정이 없어요. 잠시 뒤 다시 시도해 주세요.');
  const toss = await loadTossPayments(client_key);
  await toss.payment({ customerKey: customer.id }).requestPayment({
    method: 'CARD',
    amount: { currency: 'KRW', value: p.amount },
    orderId: p.orderId,
    orderName: p.orderName.slice(0, 100), // 토스 규칙: 100자 이하
    customerName: customer.name,
    customerEmail: customer.email,
    successUrl: `${window.location.origin}/payments/success`,
    failUrl: `${window.location.origin}/payments/fail`,
  });
}
