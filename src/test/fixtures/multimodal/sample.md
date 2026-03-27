# Project Architecture

This document describes the overall architecture of the system.

## Backend Services

The backend is built with Node.js and Express. It uses a PostgreSQL database for persistent storage and Redis for caching. All API endpoints follow RESTful conventions with proper HTTP status codes and JSON response bodies.

Authentication is handled via JWT tokens with refresh token rotation. Each request passes through middleware that validates the token signature and checks expiration.

## Frontend Application

The frontend is a React single-page application built with TypeScript. It uses React Router for navigation, React Query for server state management, and Zustand for client state.

The component library is built on top of Radix UI primitives with custom styling via Tailwind CSS. All components support both light and dark themes.

## Infrastructure

The application is deployed on AWS using ECS Fargate for container orchestration. The CI/CD pipeline runs on GitHub Actions with separate staging and production environments. Database migrations are managed with Prisma.
