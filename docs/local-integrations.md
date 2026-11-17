# 결제 · 알림 로컬 설정 (토스 · 카카오 · SES)

키는 저장소에 올리지 않는다. 다른 PC에서는 아래 "PC마다 할 일"만 다시 하면 된다. 콘솔 설정(처음 한 번)은 계정에 남아 있다.
설계 결정은 [decisions.md](decisions.md) APP-001 ~ 003.

## PC마다 할 일 (학원 · 집)

```bash
cd /c/dev/hotel-booking-app && git pull

# 1) 로컬 DB에 새 테이블(적립금 · 결제 · 카카오). 로컬 앱 컨테이너는 migrate를 돌리지 않고,
#    DB 볼륨은 처음 만들 때만 스키마를 넣어서 기존 볼륨에는 새 테이블이 없다. 몇 번 실행해도 결과가 같다
docker compose up -d db
docker compose exec -T db mysql -uroot -plocal-root-pw hotel_booking < db/schema.sql
docker compose exec -T db mysql -uroot -plocal-root-pw hotel_booking_test < db/schema.sql

# 2) 키 넣기 (값은 아래 콘솔에서 다시 확인)
cp .env.example .env
code .env

# 3) 실행. 코드가 바뀌었으면 --build. .env만 바꿨으면 docker compose up -d로 충분(설정이 바뀐 컨테이너는 Compose가 다시 만듦)
docker compose up -d --build
```

| .env | 어디서 |
|---|---|
| `TOSS_CLIENT_KEY` (`test_ck_…`) · `TOSS_SECRET_KEY` (`test_sk_…`) | 토스 개발자센터 [API 키 메뉴](https://developers.tosspayments.com/my/api-keys)의 **API 개별 연동 키**. `test_gck` · `test_gsk`(주문서형 · 결제창형 연동 키)는 쓰지 않는다 |
| `KAKAO_REST_API_KEY` | 카카오 [앱] > [플랫폼 키] > [REST API 키] |
| `KAKAO_CLIENT_SECRET` | 카카오 [앱] > [플랫폼 키] > [REST API 키] > [클라이언트 시크릿] (기본으로 켜져 있음) |
| `KAKAO_REDIRECT_URI` | `http://localhost:3000/kakao/callback` (카카오에 등록한 값과 한 글자도 다르면 KOE006) |
| `MAIL_FROM` | 비워 둠. 로컬 docker에는 AWS 자격 증명이 없어 실제 메일은 AWS 배포 연결 때 확인 |

## 확인

1. http://localhost:3000 → 가입 · 로그인 → 내 예약 → "카카오톡 알림 받기" → 카카오 동의 → "연결했어요"
2. 숙소 예약 → 토스 결제창 → 결제 완료 화면 → 내 예약에 "결제 완료"
3. 카카오톡 **나와의 채팅방**에 예약 확정 메시지
4. 결제창을 그냥 닫으면 내 예약에 "결제 대기 · 결제하기", 10분 지나면 자동 취소

## 콘솔 설정 (처음 한 번, 2026-11-18 해 둠)

**토스:** [회원가입](https://app.tosspayments.com/signup)(이메일만, 사업자 · 결제 신청 없이 테스트 키 사용 가능) → 개발자센터 로그인 → [API 키 메뉴](https://developers.tosspayments.com/my/api-keys). 테스트 키는 실제로 돈이 빠지지 않는다.

**카카오** ([카카오 로그인 설정](https://developers.kakao.com/docs/latest/ko/kakaologin/prerequisite), [앱 설정](https://developers.kakao.com/docs/latest/ko/app-setting/app)):

| 메뉴 | 설정 |
|---|---|
| [앱 관리 페이지] → [앱 생성] | 앱 이름 · 회사명 · 카테고리 |
| [앱] > [플랫폼 키] > [REST API 키] > 카카오 로그인 리다이렉트 URI | `http://localhost:3000/kakao/callback`, `https://hotel.vundle34.cloud/kakao/callback` (최대 10개) |
| [카카오 로그인] > [사용 설정] > [상태] | ON (꺼져 있으면 KOE004) |
| [카카오 로그인] > [동의항목] > [접근권한] > 카카오톡 메시지 전송 | 선택 동의 |
| [앱] > [제품 링크 관리] > [웹 도메인] | `http://localhost:3000`, `https://hotel.vundle34.cloud` |

"나에게 보내기"는 비즈 앱 · 심사가 필요 없다(친구에게 보낼 때만 필요).

## 문제가 생기면

| 증상 | 원인 | 할 일 |
|---|---|---|
| 서버 오류 500, 로그에 `Table '…point_transactions' (또는 payments · kakao_links) doesn't exist` | 기존 DB 볼륨에 새 테이블 없음 | 위 1) 스키마 넣기 |
| 카카오 KOE006 | 리다이렉트 URI가 등록 값과 다름(http/https · 끝 `/` 포함) | `.env`와 콘솔 값을 똑같이 |
| 카카오 KOE004 | 카카오 로그인 꺼짐 | [카카오 로그인] > [사용 설정] > [상태] ON |
| "메시지 전송에 동의해야 알림을 받을 수 있어요" | 동의 화면에서 메시지 전송 체크를 풀었음 | 다시 연결하며 체크 |
| 결제는 됐는데 카톡이 안 옴, 앱 로그(`docker compose logs app`)에 `code -402: insufficient scopes.` | 동의항목을 설정하기 전에 연결해 메시지 동의가 없는 토큰 (2026-11-18 실제로 겪음) | 이 오류가 나면 연결이 자동으로 지워짐 → 내 예약에서 다시 "카카오톡 알림 받기" → 동의 화면에서 "카카오톡 메시지 전송" 체크 |
| 결제창이 키 오류 | 주문서형 키(`test_gck`)를 넣었음 | API 개별 연동 키(`test_ck` · `test_sk`)로 |
| "카카오톡 알림 받기" 버튼이 안 보임 | `KAKAO_REST_API_KEY`가 비어 있음 | `.env` 채우고 `docker compose up -d` |

## AWS 배포 연결 (아직 안 함)

앱 태스크에 `APP_URL=https://hotel.vundle34.cloud`, `KAKAO_REDIRECT_URI=https://hotel.vundle34.cloud/kakao/callback`, 키(SSM), `MAIL_FROM`과 SES 도메인 인증 · 앱 태스크 역할(`ses:SendEmail`)을 넣는다(인프라 저장소 03 계획 "3단계 전: 결제 · 알림 앱 기능"). 그전까지 AWS에서는 결제 · 메일 · 카카오가 꺼진 채 지금처럼 동작한다.
