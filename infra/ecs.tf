resource "aws_ecs_cluster" "main" {
  name = local.ecs_cluster_name

  # Container Insights is deliberately off: it bills per metric and buys little on a
  # single-task service already shipping structured Pino logs to CloudWatch.
  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = { Name = local.ecs_cluster_name }
}

resource "aws_ecs_task_definition" "backend" {
  family                   = "${local.name_prefix}-backend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"

  cpu    = 512  # 0.5 vCPU
  memory = 1024 # 1 GB

  # Two roles, two jobs. The execution role is assumed by the ECS agent before the
  # container starts -- it pulls the image and resolves `secrets` below. The task
  # role is assumed by the running application process. See iam.tf.
  execution_role_arn = aws_iam_role.ecs_task_execution.arn
  task_role_arn      = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "sampark-backend"
      essential = true

      # ECR tags are IMMUTABLE and the repository is currently empty, so this tag
      # cannot be pulled. The service will report CannotPullContainerError until CI
      # pushes a real commit-SHA tag and updates the service. Expected, not a fault.
      image = "${aws_ecr_repository.backend.repository_url}:placeholder"

      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port # awsvpc: must equal containerPort
          protocol      = "tcp"
        }
      ]

      # Non-sensitive configuration. Kept out of Secrets Manager on purpose: a
      # bucket name is not a secret, and burying it in the secret would freeze it
      # under that resource's ignore_changes guard.
      environment = [
        # NODE_ENV is the *Node runtime mode*, not the AWS environment tag. env.ts
        # accepts only development | test | production -- "staging" fails the Zod
        # parse and the process exits before it can serve a request.
        { name = "NODE_ENV", value = "production" },
        { name = "HOST", value = "0.0.0.0" },
        { name = "PORT", value = tostring(var.container_port) },
        { name = "LOG_LEVEL", value = "info" },

        # Without these three, createStorageProvider() falls through to
        # MockStorageProvider: uploads return fake URLs, nothing reaches S3, and the
        # task role's s3:PutObject grant goes unused. It fails silently, not loudly.
        { name = "STORAGE_PROVIDER", value = "s3" },
        { name = "S3_BUCKET", value = aws_s3_bucket.media.bucket },
        { name = "S3_REGION", value = var.aws_region },

        # Explicit, though it is also the default.
        # ADR-042. SMS_PROVIDER and MOCK_OTP_ECHO are GONE with the SMS-OTP login track.
        # There is no OTP to echo and no gateway to select: every account now signs in
        # with email+password, so the staging escape hatch has nothing left to reopen.

        # ADR-034. The non-secret half of the connection string. docker-entrypoint.sh
        # composes DATABASE_URL from these plus DB_PASSWORD below.
        #
        # A hostname is not a secret, and putting it in Secrets Manager would freeze
        # it under that resource's ignore_changes guard -- the same reasoning as
        # S3_BUCKET above.
        { name = "DB_HOST", value = aws_db_instance.main.address },
        { name = "DB_PORT", value = tostring(aws_db_instance.main.port) },
        { name = "DB_USER", value = aws_db_instance.main.username },
        { name = "DB_NAME", value = aws_db_instance.main.db_name },
      ]

      # Resolved by the EXECUTION role at container start and injected as ordinary
      # environment variables. The application never calls Secrets Manager.
      #
      # The `:KEY::` suffix is load-bearing -- it extracts one JSON key. Without it
      # ECS injects the entire JSON blob as the value, and the failure surfaces at
      # task start, not at plan time.
      secrets = [
        # ADR-034. Straight from the secret RDS owns and rotates -- NOT a copy.
        #
        # DATABASE_URL used to live in sampark/staging as a hand-assembled string
        # containing this password. `sampark_app` IS the RDS master user and
        # manage_master_user_password rotates it every 7 days, so the copy was
        # guaranteed to go stale. It did, on 2026-07-17, exactly 7 days after it was
        # written (Backend#17).
        #
        # Referenced through the resource attribute, never a hardcoded ARN: the
        # secret is created by RDS, and its name carries a generated suffix.
        {
          name      = "DB_PASSWORD"
          valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::"
        },
        {
          name      = "JWT_SECRET"
          valueFrom = "${aws_secretsmanager_secret.app.arn}:JWT_SECRET::"
        },
        # ADR-038 / SDR-007. Scoped machine credential for POST /cadres/import. Like
        # JWT_SECRET, the VALUE is written by hand into the sampark/<env> JSON (the
        # secret_version's secret_string is under ignore_changes); this only wires the
        # reference. The IMPORT_API_KEY JSON key MUST exist in the secret before a task
        # referencing it starts, or ECS fails to resolve it at container start.
        #
        # Deploy ordering (the service has ignore_changes on task_definition, so a
        # `terraform apply` alone will NOT move the running service onto the new
        # revision): 1) put IMPORT_API_KEY into the secret; 2) `terraform apply` to
        # register a task-def revision carrying this reference; 3) point the service at
        # that revision once (`aws ecs update-service --task-definition <fam>:<N>
        # --force-new-deployment`). Thereafter CI's download-live-taskdef→swap-image
        # preserves it, exactly as it preserves JWT_SECRET. Env.ts treats the key as
        # OPTIONAL, so until this lands the import route simply falls back to
        # super_admin-JWT-only and nothing else breaks.
        {
          name      = "IMPORT_API_KEY"
          valueFrom = "${aws_secretsmanager_secret.app.arn}:IMPORT_API_KEY::"
        },
      ]

      # The log group is declared in logs.tf rather than auto-created here, so its
      # 30-day retention actually applies. An ECS-created group retains forever.
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.backend.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }

      # server.ts traps SIGTERM and drains pg-boss + Fastify before exiting. Give it
      # room; the default 30s is the same, stated so a future edit is deliberate.
      stopTimeout = 30
    }
  ])

  tags = { Name = "${local.name_prefix}-backend" }
}

resource "aws_ecs_service" "backend" {
  name            = local.ecs_service_name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  # platform_version: "LATEST" despite ADR-015 Rule 1's always-pin standing rule.
  # The rule exists because a database engine version is a data-format commitment --
  # a silent major bump strands the schema. A Fargate platform version is a managed
  # runtime with no persistent state, so a bump cannot corrupt or strand anything.
  # "1.4.0" IS a valid pin and is what LATEST currently resolves to; pinning it just
  # means tracking AWS's deprecation notices by hand for no benefit.
  # See ADR-015 Rule 1, exception clause.
  platform_version = "LATEST"

  network_configuration {
    subnets         = aws_subnet.public[*].id
    security_groups = [aws_security_group.fargate.id]

    # Open Decision 1: tasks sit in public subnets with a public IP instead of
    # behind a NAT Gateway, saving ~Rs 3,655/month. They are not publicly reachable
    # -- fargate-sg accepts inbound only from alb-sg. The security group is the
    # access control, not the subnet tier. Without this, the task cannot reach ECR
    # or Secrets Manager and never starts.
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.backend.arn
    container_name   = "sampark-backend"
    container_port   = var.container_port
  }

  # The ALB health check must not start counting until prisma migrate deploy has run
  # and Fastify is listening. Too short and ECS kills the task mid-migration.
  health_check_grace_period_seconds = 120

  # Zero-downtime rolling deploy: 1 old + 1 new task in flight, never fewer than one
  # serving. Peak is 1.0 vCPU against a 6.0 quota.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # A task definition that crashes on boot reverts to the last working revision
  # instead of looping. Note there is no previous revision yet, so the first
  # deployment simply fails and the service holds at zero running tasks.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Backed by the ssmmessages grant on the task role (iam.tf).
  enable_execute_command = true

  propagate_tags = "SERVICE"

  tags = { Name = local.ecs_service_name }

  # The listener must exist before the service registers targets against its group.
  depends_on = [aws_lb_listener.http]

  lifecycle {
    # CI owns the deployed image. GitHub Actions registers a new task definition
    # revision with the commit-SHA tag and calls UpdateService. Without this, the
    # next `terraform apply` would drag the service back to whatever revision
    # Terraform last recorded -- redeploying `:placeholder` over a working release.
    ignore_changes = [task_definition]
  }
}
