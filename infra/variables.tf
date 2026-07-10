variable "aws_region" {
  description = "AWS region for every resource. Data residency: India only (ADR / root CLAUDE.md)."
  type        = string
  default     = "ap-south-1"

  validation {
    condition     = startswith(var.aws_region, "ap-south-")
    error_message = "Data residency rule: SAMPARK resources must stay in an India region (ap-south-*)."
  }
}

variable "aws_profile" {
  description = "Local AWS CLI profile Terraform authenticates with. Must not be the account root."
  type        = string
  default     = "sampark-admin"
}

variable "project" {
  description = "Project name. Feeds the resource name prefix and the Project tag."
  type        = string
  default     = "sampark"
}

variable "environment" {
  description = "Deployment environment. Part of the name prefix, so staging and production never collide."
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be one of: staging, production."
  }
}

variable "owner" {
  description = "Owner tag applied to every resource."
  type        = string
  default     = "bitcrackers"
}

# ---------------------------------------------------------------------------
# Network. Consumed by network.tf (written in step 4).
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "The two AZs the VPC spans. Order is significant: index 0 pairs with subnet index 0."
  type        = list(string)
  default     = ["ap-south-1a", "ap-south-1b"]

  validation {
    condition     = length(var.availability_zones) == 2
    error_message = "Exactly two AZs are required (ALB needs >= 2; RDS subnet group needs >= 2)."
  }
}

variable "public_subnet_cidrs" {
  description = "Public subnets. Hold the ALB and -- per Open Decision 1 -- the Fargate tasks, which take a public IP so no NAT Gateway is needed."
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnet_cidrs" {
  description = "Private subnets. RDS only. No route to the internet."
  type        = list(string)
  default     = ["10.0.11.0/24", "10.0.12.0/24"]
}

# ---------------------------------------------------------------------------
# Application. Consumed by ecs.tf / alb.tf (written in step 4).
# ---------------------------------------------------------------------------

variable "container_port" {
  description = "Port the Fastify server listens on. Must match PORT in the task definition."
  type        = number
  default     = 3000
}

variable "mock_otp_echo" {
  description = "Staging-only: log OTPs to CloudWatch. Must be false in production."
  type        = bool
  default     = false

  # The default is the safety mechanism. A production workspace that simply never
  # mentions this variable cannot enable it; enabling requires an explicit override
  # in terraform.tfvars. The validation makes an accidental production override fail
  # at plan time rather than leaking OTPs to CloudWatch at runtime.
  validation {
    condition     = !(var.mock_otp_echo && var.environment == "production")
    error_message = "mock_otp_echo must be false when environment is production: it writes OTPs to CloudWatch in plaintext."
  }
}

variable "health_check_path" {
  description = "ALB target group health check path. /healthz is liveness only -- deliberately NOT /readyz, which 503s on a transient DB blip and would trigger a task-replacement storm."
  type        = string
  default     = "/healthz"
}

# ---------------------------------------------------------------------------
# GitHub OIDC. Consumed by github_oidc.tf (written in step 4).
# ---------------------------------------------------------------------------

variable "github_repository" {
  description = "owner/repo allowed to assume the CI deploy role via OIDC."
  type        = string
  default     = "Om25091210/Sampark-Backend"
}

variable "github_branch" {
  description = "Branch allowed to assume the CI deploy role. Scopes the OIDC trust policy to a single ref."
  type        = string
  default     = "main"
}
