import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TripEntity } from '../trip/trip.entity';
import { BudgetController } from './budget.controller';
import { BudgetEntity } from './budget.entity';
import { BudgetService } from './budget.service';

@Module({
  imports: [TypeOrmModule.forFeature([BudgetEntity, TripEntity])],
  controllers: [BudgetController],
  providers: [BudgetService]
})
export class BudgetModule {}
