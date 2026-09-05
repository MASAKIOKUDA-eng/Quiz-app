#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { QuizAppStack } from '../lib/quiz-app-stack';

const app = new cdk.App();

new QuizAppStack(app, 'QuizAppStack', {
  description:
    'Cost-optimized fully-serverless quiz application (DynamoDB on-demand, ARM64 Lambda, HTTP API, S3 + CloudFront).',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

app.synth();
