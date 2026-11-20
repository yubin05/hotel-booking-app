# 이전 환경(legacy) 올리기 (새 PC 기준)

고객사가 IDC에서 운영하던 환경(As-Is)을 서울 리전에 같은 모양으로 만든 것입니다. 앱을 띄워 브라우저로 확인한 뒤 지우는 순서입니다. 설계 근거는 인프라 저장소의 [ADR-016](https://github.com/yubin05/hotel-booking-aws-v2/blob/main/docs/07-experiments.md#adr-016) · [ADR-021](https://github.com/yubin05/hotel-booking-aws-v2/blob/main/docs/07-experiments.md#adr-021)에 있습니다.

- 만드는 것(17개): VPC · 서브넷 · NAT 인스턴스, 웹+앱 EC2(퍼블릭 서브넷), MySQL EC2(프라이빗 서브넷), 보안 그룹 2개, 키 페어. 서버 3대 모두 t3.micro
- 부하 시험 날만: 부하 발생기 EC2(퍼블릭 서브넷) + 보안 그룹 → 19개. `-var is_load_test=true`로 켜고, 변수 없이 `terraform apply`하면 발생기만 지웁니다([ADR-023](https://github.com/yubin05/hotel-booking-aws-v2/blob/main/docs/07-experiments.md#adr-023)). 발생기는 인프라팀(이관 수행사)이 이관 전 기준선을 재려고 이 환경 안에 띄우는 측정 장비입니다. 시험 순서는 인프라 저장소의 [load/README.md](https://github.com/yubin05/hotel-booking-aws-v2/blob/main/load/README.md)에 있습니다
- 비용: 켜 둔 동안 시간당 약 $0.049. 발생기를 켜면 약 $0.018 추가(t3.micro일 때). **작업이 끝나면 반드시 `terraform destroy`**

## 처음 한 번 (새 PC 준비)

| 준비물 | 확인 명령 | 메모 |
|---|---|---|
| Git Bash | | 아래 명령은 모두 Git Bash 기준 |
| AWS CLI 2.32.0 이상 | `aws --version` | `aws login` 명령이 이 버전부터 있음 ([ADR-018](https://github.com/yubin05/hotel-booking-aws-v2/blob/main/docs/04-decisions.md#adr-018)) |
| Terraform 1.x | `terraform version` | 1.17.0 · AWS provider 6.x에서 확인 |
| Docker Desktop | `docker version` | **앱 이미지를 새로 만들 때만.** 이미 올린 이미지로 띄우기만 하면 필요 없음 |

평소 사용자의 legacy 권한([iam/](iam/main.tf))은 AWS 계정에 한 번 만들어 두는 것이라 PC가 바뀌어도 그대로입니다. 아래 [legacy 권한 붙이기](#legacy-권한-붙이기-관리자)를 보세요.

```bash
# 1. 저장소 받기
git clone https://github.com/yubin05/hotel-booking-app.git /c/dev/hotel-booking-app
cd /c/dev/hotel-booking-app/legacy

# 2. SSH 키 (코멘트는 영문만: 한글이면 AWS가 키 등록을 거부함)
ssh-keygen -t ed25519 -f ~/.ssh/hotel-legacy -C "hotel-legacy"

# 3. SSH를 허용할 내 IP (장소가 바뀌면 다시)
curl -s https://checkip.amazonaws.com
cp terraform.tfvars.example terraform.tfvars   # 열어서 ["<위 IP>/32"]로 고치기

# 4. 비밀값 (저장소 밖. 다른 PC에서 복사해 올 필요 없음: DB를 매일 새로 만들어서 새 값이어도 됨)
mkdir -p ~/.hotel-legacy
cat > ~/.hotel-legacy/db.env <<EOF
MYSQL_ROOT_PASSWORD=$(openssl rand -hex 16)
MYSQL_DATABASE=hotel_booking
MYSQL_USER=app
MYSQL_PASSWORD=$(openssl rand -hex 16)
EOF
cat > ~/.hotel-legacy/app.env <<EOF
JWT_SECRET=$(openssl rand -hex 32)
EOF

# 5. Terraform 준비
terraform init
```

키 페어는 apply할 때 이 PC의 공개 키(`~/.ssh/hotel-legacy.pub`)로 만들고 destroy할 때 지웁니다. 그래서 PC마다 키를 새로 만들어도 됩니다.

## legacy 권한 붙이기 (관리자)

평소 사용자 그룹에는 평소에 이 권한이 붙어 있지 않습니다. legacy 작업을 하는 날만 관리자 역할로 붙이고, 끝나면 뗍니다. 이 폴더는 평소 사용자가 apply하는 legacy 루트와 따로 있어야 합니다. 같은 곳에 있으면 평소 사용자가 자기 권한을 스스로 늘릴 수 있습니다.

```bash
cd /c/dev/hotel-booking-app/legacy/iam
aws login --profile admin            # 콘솔에서 관리자 역할로 전환한 상태에서
AWS_PROFILE=admin terraform init     # 처음 받은 PC에서 한 번 (state는 S3의 legacy-iam/terraform.tfstate)
[ -f terraform.tfvars ] || cp terraform.tfvars.example terraform.tfvars   # 처음 한 번 (커밋 안 되는 파일)
# terraform.tfvars의 attach_operator_legacy를 true로 바꾼 뒤
AWS_PROFILE=admin terraform plan     # 1 to add
date; AWS_PROFILE=admin terraform apply; date   # 끝나면 false로 되돌리고 다시 apply (1 to destroy)
```

## 매일: 올리기 → 확인 → 지우기

```bash
cd /c/dev/hotel-booking-app/legacy

aws login
aws sts get-caller-identity          # Arn에 :user/ 가 보여야 평소 권한 (관리자 역할이면 :assumed-role/)
eval "$(ssh-agent -s)"; ssh-add ~/.ssh/hotel-legacy   # Git Bash 창마다

date; terraform apply                # 17개 추가 (부하 시험 날: terraform apply -var is_load_test=true → 19개)
bash start-db.sh                     # 끝에 hotels 1010이 나오면 DB 준비 완료
bash start-app.sh yubin05/hotel-booking-aws-v2:<태그>   # 끝에 {"status":"ok","db":"ok"}와 브라우저 주소
```

- `<태그>`: [Docker Hub 저장소](https://hub.docker.com/r/yubin05/hotel-booking-aws-v2/tags)의 최신 태그(커밋 SHA, [ADR-022](https://github.com/yubin05/hotel-booking-aws-v2/blob/main/docs/04-decisions.md#adr-022))
- 브라우저에서 `http://<앱 IP>`를 열어 확인합니다. HTTP라 로그인 정보가 평문으로 오가므로 다른 곳에서 쓰는 비밀번호는 쓰지 마세요.
- 서버 지문을 물으면 `yes`. 스크립트가 매번 예전 서버 기록을 지워서 날마다 묻습니다. post-quantum 경고는 무시해도 됩니다.

끝낼 때:

```bash
terraform destroy; date              # 17개 삭제
```

## 앱을 고쳐서 이미지를 새로 만들 때

```bash
docker login --username yubin05      # 비밀번호 자리에 Docker Hub 개인 액세스 토큰(Repo Read & Write)
cd /c/dev/hotel-booking-app
git status --short                   # 아무것도 안 나와야 함 (커밋한 코드만 이미지로)
TAG=$(git rev-parse --short HEAD)
docker build -t yubin05/hotel-booking-aws-v2:$TAG .
docker push yubin05/hotel-booking-aws-v2:$TAG
cd legacy && bash start-app.sh yubin05/hotel-booking-aws-v2:$TAG   # 서버가 떠 있으면 컨테이너만 바꿔 다시 배포
```

2026-11-14 저장소 분리 전 이미지 태그는 인프라 저장소의 커밋 SHA입니다.

## 주의

- **Terraform 상태(state)는 apply한 PC에만 있습니다**(저장소에 올리지 않음). 다른 PC는 그 리소스를 모르므로 apply한 PC에서 destroy하세요. PC를 옮기기 전에 서버가 남아 있지 않은지 확인합니다. 남아 있으면 요금이 계속 나가고, 같은 이름의 키 페어가 있어서 새 PC의 apply도 실패합니다.
  ```bash
  aws ec2 describe-instances --region ap-northeast-2 --filters Name=instance-state-name,Values=pending,running \
    --query 'Reservations[].Instances[].Tags[?Key==`Name`].Value' --output text   # 아무것도 안 나와야 함
  ```
- 문제가 생기면 [check-db.sh](check-db.sh)로 DB 서버의 설치 로그와 NAT 대기 횟수를 봅니다.
- 지금까지 겪은 문제와 결과는 인프라 저장소 [03 진행 계획의 결과 기록](https://github.com/yubin05/hotel-booking-aws-v2/blob/main/docs/03-plan.md#결과-기록)에 있습니다.
