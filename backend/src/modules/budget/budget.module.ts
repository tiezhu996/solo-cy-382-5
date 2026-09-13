import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TripEntity } from '../trip/trip.entity';
import { BudgetController } from './budget.controller';
import { BudgetEntity } from './budget.entity';
import { BudgetService } from './budget.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([BudgetEntity, TripEntity]),
    JwtModule.register({ secret: process.env.JWT_SECRET ?? 'dev_secret' })
  ],
  controllers: [BudgetController],
  providers: [BudgetService]
})
export class BudgetModule {}
