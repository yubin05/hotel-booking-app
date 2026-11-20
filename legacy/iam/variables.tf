# legacy 작업을 하는 날만 true로 관리자 역할 apply (붙였다 떼기). 값은 terraform.tfvars(커밋 안 함) 또는 -var
variable "attach_operator_legacy" {
  type        = bool
  default     = false
  description = "legacy 작업을 하는 날만 true로 바꿔 관리자 역할로 apply (붙였다 떼기)"
}
