#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { buildApp } from '../lib/build-app';

const account = process.env['CDK_DEFAULT_ACCOUNT'];
const region = process.env['CDK_DEFAULT_REGION'];
buildApp(new App(), { ...(account !== undefined && { account }), ...(region !== undefined && { region }) });
