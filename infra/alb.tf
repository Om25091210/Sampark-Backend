# Cost: ~Rs 1,800/month baseline (LB-hours + roughly 1 LCU at this traffic).
# At the production flip, WAF v2 adds a $5/month web ACL plus $1/month per managed
# rule group; the four rule groups on the Phase 2 list bring it to ~Rs 800/month,
# for ~Rs 2,600/month total. Request charges ($0.60 per million) are negligible here.
resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  load_balancer_type = "application"
  internal           = false
  ip_address_type    = "ipv4"

  subnets         = aws_subnet.public[*].id
  security_groups = [aws_security_group.alb.id]

  # Explicit rather than inherited, so a provider default change cannot move it.
  idle_timeout = 60
  enable_http2 = true

  # Cross-zone load balancing is always on for an ALB and is not configurable --
  # the enable_cross_zone_load_balancing argument applies only to network and
  # gateway load balancers. Stated here because the requirement was explicit.

  # Staging teardown must stay cheap. Production flips this to true.
  enable_deletion_protection = false

  # Access logs: disabled. Enabling them needs an S3 bucket with a policy granting
  # the regional ELB service principal PutObject, which is its own resource set.
  # Phase 2 item -- see the Phase 2 Migration Checklist in DESIGN.md.

  # WAF: not associated. Phase 2 item (WAF v2 + AWS managed rule groups).

  tags = { Name = "${local.name_prefix}-alb" }
}

resource "aws_lb_target_group" "backend" {
  name     = "${local.name_prefix}-tg"
  vpc_id   = aws_vpc.main.id
  port     = var.container_port
  protocol = "HTTP"

  # `ip`, not `instance`: Fargate tasks in awsvpc mode register by ENI address.
  target_type = "ip"

  # Default is 300s. A staging deploy would otherwise spend five minutes draining a
  # task that has no long-lived connections to drain.
  deregistration_delay = 30

  health_check {
    enabled  = true
    path     = var.health_check_path
    port     = "traffic-port"
    protocol = "HTTP"
    matcher  = "200"

    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  # The target group is referenced by the ECS service. Replacing it (a name or
  # target_type change) would otherwise deadlock against the live listener.
  lifecycle {
    create_before_destroy = true
  }

  tags = { Name = "${local.name_prefix}-tg" }
}

# HTTP only. TLS is a Phase 2 upgrade and needs a Route 53 hosted zone plus an ACM
# certificate for api.bitcrackers.in before a :443 listener can exist.
#
# Until then, officer JWTs and SMS OTPs cross public mobile networks in cleartext.
# That is acceptable for an integration environment holding seeded data, and is the
# reason this environment is tagged Environment=staging rather than production.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend.arn
  }

  tags = { Name = "${local.name_prefix}-listener-http" }
}
