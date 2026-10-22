# Remote state in the bootstrap bucket; the bucket arrives with -backend-config="bucket=…".
terraform {
  backend "gcs" {
    prefix = "infra/main"
  }
}
