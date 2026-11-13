# hotel-booking-app

호텔 예약 사이트의 앱 저장소입니다.

> 이 저장소는 **고객사 개발팀의 앱 저장소 역할**을 하는 시나리오용 앱입니다. 포트폴리오에서 평가받을 대상은 인프라 저장소 [hotel-booking-aws-v2](https://github.com/yubin05/hotel-booking-aws-v2)이고, 이 앱은 AWS로 이관할 서비스 역할을 합니다.

## 구성

```
src/   모듈러 모놀리스 API (인증·호텔·예약·쿠폰·리뷰)
web/   화면 (React + Vite + Tailwind, 빌드 결과는 public/)
db/    스키마와 시드
```

## 로컬 실행

```bash
docker compose up -d --build   # MySQL(호텔·객실 시드 포함) + 앱
npm ci && npm test             # 테스트는 같은 MySQL의 테스트 전용 DB(hotel_booking_test)를 사용
```

브라우저에서 http://localhost:3000 을 열면 화면이 나옵니다. 화면만 고칠 때는 `cd web && npm ci && npm run dev`로 개발 서버(5173)를 띄우면 API 요청은 3000번 앱으로 넘어갑니다.

## CI/CD (GitHub Actions)

- **CI** (`ci.yml`): PR과 main push마다 테스트와 이미지 빌드를 확인합니다.
- **CD** (`cd.yml`): 인프라팀이 작성해 제공한 워크플로입니다. 손으로 실행하면 이미지를 빌드해 서울 ECR에 올립니다. AWS 접근은 OIDC로 받는 배포 역할(main 브랜치만)을 쓰고, 이 저장소에는 AWS 키를 두지 않습니다. 배포 역할과 권한은 인프라 저장소가 관리합니다.
