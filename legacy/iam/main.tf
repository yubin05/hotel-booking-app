# 이전 환경(legacy)을 올리고 지우는 평소 사용자 권한. 관리자 역할로만 apply한다
# legacy 루트는 평소 사용자가 매일 apply하므로, 이 정책을 거기서 관리하면 자기 권한을 스스로 늘릴 수 있다 (인프라 저장소 ADR-043)
terraform {
  # use_lockfile(S3 네이티브 잠금)은 1.11부터
  required_version = ">= 1.11.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # 한 AWS 계정에서 시나리오를 재현하느라 인프라팀의 state 버킷을 같이 쓴다. key로 다른 루트와 구분
  backend "s3" {
    bucket       = "hotel-booking-aws-v2-tfstate-248563009287-ap-northeast-1-an"
    key          = "legacy-iam/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
  }
}

# IAM은 전역 서비스라 리전은 legacy와 같게만 맞춤
provider "aws" {
  region = "ap-northeast-2"
}

locals {
  operator_group = "normal-user-group" # 평소 사용자가 속한 그룹

}

resource "aws_iam_policy" "operator_legacy" {
  name        = "hotel-booking-aws-v2-operator-legacy"
  description = "Operator: stage 1 legacy root (attach only while working on legacy)"
  policy      = file("${path.module}/legacy-operator-policy.json")
}

resource "aws_iam_group_policy_attachment" "operator_legacy" {
  count      = var.attach_operator_legacy ? 1 : 0
  group      = local.operator_group
  policy_arn = aws_iam_policy.operator_legacy.arn
}
