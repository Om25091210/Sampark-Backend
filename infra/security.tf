# Three tiers, each reachable only from the one in front of it:
#
#   internet --80--> alb-sg --3000--> fargate-sg --5432--> rds-sg
#
# Rules reference peer security groups by ID, never by CIDR, so they stay correct
# if subnet ranges ever change and cannot be satisfied by an unrelated host that
# happens to sit in the same range.
#
# Rules are standalone `aws_vpc_security_group_*_rule` resources rather than inline
# `ingress`/`egress` blocks. Inline blocks would create a dependency cycle here --
# alb-sg egresses to fargate-sg while fargate-sg ingresses from alb-sg -- and they
# also silently clobber rules added out-of-band. Each rule is its own resource.

# `name_prefix`, not `name`: security group names must be unique per VPC, so a fixed
# name plus create_before_destroy deadlocks on replacement (the new SG cannot be
# created while the old one still holds the name). AWS appends a unique suffix.
# The Name tag stays exact -- that is what the console displays.
#
# create_before_destroy is required because an SG attached to a live ALB or ECS
# service cannot be deleted; the replacement must exist before the original goes.

resource "aws_security_group" "alb" {
  name_prefix = "${local.name_prefix}-alb-sg-"
  description = "SAMPARK ALB: HTTP 80 from the internet, forwards to Fargate tasks"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name_prefix}-alb-sg" }

  # AWS attaches an allow-all egress rule to every new security group. Declaring no
  # inline egress makes Terraform revoke it, leaving only the rules defined below.
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "fargate" {
  name_prefix = "${local.name_prefix}-fargate-sg-"
  description = "SAMPARK Fargate tasks: inbound only from the ALB"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name_prefix}-fargate-sg" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "rds" {
  name_prefix = "${local.name_prefix}-rds-sg-"
  description = "SAMPARK RDS: inbound only from Fargate tasks"
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name_prefix}-rds-sg" }

  lifecycle {
    create_before_destroy = true
  }
}

# ---------------------------------------------------------------------------
# alb-sg
# ---------------------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "alb_http_in" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from the internet (TLS is a Phase 2 upgrade)"

  cidr_ipv4   = "0.0.0.0/0"
  ip_protocol = "tcp"
  from_port   = 80
  to_port     = 80

  tags = { Name = "${local.name_prefix}-alb-http-in" }
}

resource "aws_vpc_security_group_egress_rule" "alb_to_fargate" {
  security_group_id = aws_security_group.alb.id
  description       = "Forward to Fargate tasks"

  referenced_security_group_id = aws_security_group.fargate.id
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port

  tags = { Name = "${local.name_prefix}-alb-to-fargate" }
}

# ---------------------------------------------------------------------------
# fargate-sg
# ---------------------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "fargate_from_alb" {
  security_group_id = aws_security_group.fargate.id
  description       = "App traffic from the ALB only"

  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = var.container_port
  to_port                      = var.container_port

  tags = { Name = "${local.name_prefix}-fargate-from-alb" }
}

# ECR image pulls, Secrets Manager, S3 (media bucket) and CloudWatch Logs. All are
# public AWS endpoints reached over the IGW, so this cannot be narrowed to an SG.
resource "aws_vpc_security_group_egress_rule" "fargate_https_out" {
  security_group_id = aws_security_group.fargate.id
  description       = "HTTPS to AWS APIs: ECR, Secrets Manager, S3, CloudWatch Logs"

  cidr_ipv4   = "0.0.0.0/0"
  ip_protocol = "tcp"
  from_port   = 443
  to_port     = 443

  tags = { Name = "${local.name_prefix}-fargate-https-out" }
}

resource "aws_vpc_security_group_egress_rule" "fargate_to_rds" {
  security_group_id = aws_security_group.fargate.id
  description       = "Postgres to RDS"

  referenced_security_group_id = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432

  tags = { Name = "${local.name_prefix}-fargate-to-rds" }
}

# Revoking the default allow-all egress also revokes DNS. Without these two rules a
# task cannot resolve *.ecr.ap-south-1.amazonaws.com and fails to pull its image,
# with a misleading "unable to pull" error. Scoped to the VPC resolver, not the world.
resource "aws_vpc_security_group_egress_rule" "fargate_dns_udp" {
  security_group_id = aws_security_group.fargate.id
  description       = "DNS to the VPC resolver (UDP)"

  cidr_ipv4   = var.vpc_cidr
  ip_protocol = "udp"
  from_port   = 53
  to_port     = 53

  tags = { Name = "${local.name_prefix}-fargate-dns-udp" }
}

resource "aws_vpc_security_group_egress_rule" "fargate_dns_tcp" {
  security_group_id = aws_security_group.fargate.id
  description       = "DNS to the VPC resolver (TCP, for responses over 512 bytes)"

  cidr_ipv4   = var.vpc_cidr
  ip_protocol = "tcp"
  from_port   = 53
  to_port     = 53

  tags = { Name = "${local.name_prefix}-fargate-dns-tcp" }
}

# ---------------------------------------------------------------------------
# rds-sg -- ingress only. A database has no business initiating outbound traffic.
# ---------------------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "rds_from_fargate" {
  security_group_id = aws_security_group.rds.id
  description       = "Postgres from Fargate tasks only"

  referenced_security_group_id = aws_security_group.fargate.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432

  tags = { Name = "${local.name_prefix}-rds-from-fargate" }
}
