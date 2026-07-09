# GitHub's OIDC identity provider. Lets a workflow exchange a short-lived GitHub
# token for temporary AWS credentials, so no AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
# is ever stored in GitHub secrets. Nothing to rotate, nothing to leak.
#
# thumbprint_list is deliberately omitted: since 2023 AWS validates GitHub's OIDC
# endpoint against its own trusted CA store, and a pinned thumbprint would silently
# break the trust relationship whenever GitHub rotates its intermediate certificate.
resource "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"

  # The audience the workflow requests. Matched again in the trust policy's
  # StringEquals condition -- both must agree or AssumeRoleWithWebIdentity fails.
  client_id_list = ["sts.amazonaws.com"]

  tags = { Name = "${local.name_prefix}-github-oidc" }
}

# Trust policy for the CI deploy role.
#
# Two conditions, and both are load-bearing:
#
#   `aud` == sts.amazonaws.com  -- pins the audience. Without it, a token minted for
#   a different audience could be replayed against this role.
#
#   `sub` LIKE repo:<owner>/<repo>:ref:refs/heads/*  -- pins the *repository* and
#   restricts to branch pushes. A bare `repo:<owner>/<repo>:*` would also match
#   `pull_request` subjects, letting anyone who opens a PR from a fork assume this
#   role and push images to ECR.
#
# TODO: tighten to `repo:Om25091210/Sampark-Backend:ref:refs/heads/main` once the
# CI/CD pipeline is verified working end-to-end. Tracked on the Phase 2 hardening
# list alongside VPC endpoints for S3/ECR/Secrets Manager/CloudWatch Logs.
data "aws_iam_policy_document" "github_actions_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/*"]
    }
  }
}
