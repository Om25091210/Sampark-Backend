resource "aws_ecr_repository" "backend" {
  name = "${var.project}-backend"

  # Immutable tags mean a commit SHA can never be repointed at different bytes.
  # Without this, re-pushing `:abc1234` silently changes what a rollback deploys.
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = { Name = "${var.project}-backend" }
}

# No aws_ecr_repository_policy resource: the repository stays private to this
# account. ECS pulls via the task execution role, not a cross-account grant.

resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name

  # Rules are evaluated in priority order, lowest first, and an image is acted on
  # by the first rule it matches.
  #
  # Rule 1 sweeps untagged layers. With IMMUTABLE tags these arise from multi-stage
  # build cache and from failed pushes, not from retagging.
  #
  # Rule 2 caps tagged images at 10. tagPatternList ["*"] matches every tag, which
  # is how "all tagged images" is expressed -- tagStatus "tagged" requires either
  # tagPrefixList or tagPatternList to be non-empty.
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 1 day"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 1
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep only the 10 most recent tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 10
        }
        action = { type = "expire" }
      },
    ]
  })
}
