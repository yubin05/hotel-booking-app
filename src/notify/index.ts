import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { RowDataPacket } from 'mysql2';
import { config } from '../config';
import { pool } from '../db';

// 예약 확정 알림 (인프라 ADR-037, docs/decisions.md APP-002): 이메일(SES)과 카카오톡 "나에게 보내기".
// 확정 응답을 먼저 돌려준 뒤 보내고, 실패해도 예약은 그대로 둔다(로그만). 발송은 이 모듈 한 곳에서 채널을 갈아 끼운다

export interface BookingNotice {
  bookingId: string;
  userId: string;
  email: string;
  name: string;
  subject: string;
  text: string;
  url: string;
}

let ses: SESv2Client | null = null;

async function sendEmail(n: BookingNotice): Promise<void> {
  // .local은 배달되지 않는 예약 주소(시드 · 테스트 · 부하 시험 계정). 보내면 SES 반송 · 샌드박스 오류만 쌓인다
  if (n.email.endsWith('.local')) return;
  if (!config.mail.from) {
    console.log(`[메일 미발송: MAIL_FROM 없음] ${n.subject}`);
    return;
  }
  ses ??= new SESv2Client({ region: config.mail.region });
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: config.mail.from,
      Destination: { ToAddresses: [n.email] },
      Content: {
        Simple: {
          Subject: { Data: n.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: `${n.text}\n\n${n.url}`, Charset: 'UTF-8' } },
        },
      },
    }),
  );
}

// 테스트가 채널을 바꿔 끼울 수 있게 객체로 둔다
export const channels: Record<string, (n: BookingNotice) => Promise<void>> = { email: sendEmail };

async function deliver(bookingId: string): Promise<void> {
  const [[b]] = await pool.query<RowDataPacket[]>(
    `SELECT b.check_in_date, b.check_out_date, b.guests, b.total_price, u.id AS user_id, u.email, u.name,
            h.name AS hotel_name, r.name AS room_name
       FROM bookings b JOIN users u ON u.id = b.user_id JOIN rooms r ON r.id = b.room_id JOIN hotels h ON h.id = r.hotel_id
      WHERE b.id = ?`,
    [bookingId],
  );
  if (!b) return;
  const notice: BookingNotice = {
    bookingId,
    userId: b.user_id,
    email: b.email,
    name: b.name,
    subject: `[Sponge Trip] ${b.hotel_name} 예약이 확정되었습니다`,
    text: `${b.name}님, ${b.hotel_name} ${b.room_name} 예약이 확정되었습니다.\n${b.check_in_date} ~ ${b.check_out_date} · ${b.guests}명 · ${Math.round(Number(b.total_price)).toLocaleString('ko-KR')}원`,
    url: `${config.appUrl}/me/bookings`,
  };
  const results = await Promise.allSettled(Object.entries(channels).map(([, send]) => send(notice)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`예약 알림 실패(${Object.keys(channels)[i]}) ${bookingId}: ${reason}`);
    }
  });
}

// 예약이 확정된 직후(커밋 뒤) 부른다. 기다리지 않는다
// shortcut: 큐 없이 서버 안에서 바로 보내 태스크가 그 순간 꺼지면 알림을 잃는다. 놓치면 안 되면 SQS 같은 큐로 옮긴다
export function notifyBookingConfirmed(bookingId: string): void {
  void deliver(bookingId).catch((err) => console.error(`예약 알림 실패 ${bookingId}:`, err instanceof Error ? err.message : err));
}
