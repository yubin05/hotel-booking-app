import { MessageCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, useApi } from '../api';
import { useToast } from '../toast';
import { Loading } from './ui';

// 카카오톡 "나에게 보내기" 연결 (서버 APP-003). 서버에 카카오 키가 없으면 보이지 않는다
export function KakaoConnect() {
  const toast = useToast();
  const status = useApi<{ enabled: boolean; connected: boolean }>('/kakao');
  const [busy, setBusy] = useState(false);
  if (!status.data?.enabled) return null;
  const { connected } = status.data;

  async function connect() {
    setBusy(true);
    try {
      window.location.href = (await api<{ url: string }>('/kakao/connect')).url;
    } catch (err) {
      toast((err as Error).message, 'error');
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api('/kakao', { method: 'DELETE' });
      toast('카카오톡 알림 연결을 해제했어요.', 'success');
      status.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mb-4 flex flex-wrap items-center gap-3 p-4">
      <MessageCircle size={20} className="shrink-0 text-amber-500" aria-hidden />
      <p className="mr-auto text-sm">
        {connected ? '예약이 확정되면 카카오톡(나와의 채팅방)으로 알려 드려요.' : '카카오톡으로 예약 확정 알림을 받아 보세요.'}
      </p>
      {connected ? (
        <button type="button" className="btn-outline px-3 py-1.5 text-sm" disabled={busy} onClick={disconnect}>
          연결 해제
        </button>
      ) : (
        <button type="button" className="btn-primary px-3 py-1.5 text-sm" disabled={busy} onClick={connect}>
          카카오톡 알림 받기
        </button>
      )}
    </div>
  );
}

// 카카오 동의 화면이 돌려보내는 주소(/kakao/callback). code를 서버에 넘겨 연결을 마친다
export function KakaoCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const started = useRef(false);

  useEffect(() => {
    // 개발 모드(StrictMode)는 효과를 두 번 돌리는데, 같은 code를 두 번 쓰면 카카오가 거절한다
    if (started.current) return;
    started.current = true;
    const finish = (message: string, type: 'success' | 'error') => {
      toast(message, type);
      navigate('/me/bookings', { replace: true });
    };
    if (!params.get('code')) {
      finish('카카오 연결을 마치지 못했어요. 다시 시도해 주세요.', 'error');
      return;
    }
    api('/kakao/callback', { method: 'POST', body: { code: params.get('code'), state: params.get('state') } }).then(
      () => finish('카카오톡 알림을 연결했어요.', 'success'),
      (err: Error) => finish(err.message, 'error'),
    );
  }, [params, navigate, toast]);

  return <Loading label="카카오 연결 중…" />;
}
