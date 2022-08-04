import { BaseEntity, Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";
import { MatchedDataClass } from "./matched-data-class";
import { RestMethod } from "@common/enums";

@Entity()
export class ApiEndpoint extends BaseEntity {
  @PrimaryGeneratedColumn("uuid")
  uuid: string

  @Column({ nullable: false })
  path: string

  @CreateDateColumn({ type: "timestamptz" })
  createdAt: Date

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt: Date

  @Column({ nullable: false })
  host: string

  @Column({ type: "integer"})
  totalCalls: number

  @Column({ type: "enum", enum: RestMethod})
  method: RestMethod

  @Column({ nullable: true })
  owner: string

  @OneToMany(() => MatchedDataClass, dataClass => dataClass.apiEndpoint)
  sensitiveDataClasses: MatchedDataClass[]
}
