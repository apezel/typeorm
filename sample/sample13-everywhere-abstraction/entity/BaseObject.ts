import {Column} from "../../../src/index";
import {AbstractTable} from "../../../src/decorator/tables/AbstractTable";
import {BasePost} from "./BasePost";
import {PostAuthor} from "./PostAuthor";
import {ManyToOne} from "../../../src/decorator/relations/ManyToOne";
import {PrimaryColumn} from "../../../src/decorator/columns/PrimaryColumn";

@AbstractTable()
export class BaseObject extends BasePost {

    @PrimaryColumn("double", { generated: true })
    id: number;

    @Column()
    title: string;

    @ManyToOne(type => PostAuthor, post => post.posts, {
        cascadeInsert: true,
        cascadeUpdate: true,
        cascadeRemove: true
    })
    author: PostAuthor;

}